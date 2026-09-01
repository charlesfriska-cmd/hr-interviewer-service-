/**
 * Claude provider adapter — the ONLY module permitted to import the Anthropic SDK.
 *
 * It owns provider-specific request/response translation and error mapping, and
 * nothing else. It has no knowledge of interviews, phases, evidence or gaps: it
 * receives a mode, a payload and a schema, and returns either a schema-validated
 * decision or a typed failure.
 *
 * The trust boundary is unchanged (ARCHITECTURE.md §17): the provider's own
 * structured-output guarantee is an optimization, and the returned JSON is
 * ALWAYS re-validated against the canonical Ajv schema here before anything
 * downstream sees it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { validateDecision, type LLMMode } from '../../schema/dispatch.ts';
import {
  initializationDecisionSchema,
  turnDecisionSchema,
} from '../../schema/decisions.schema.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT_V1_1 } from '../../prompt/systemPrompt.v1_1.ts';
import { serializeUserTurn } from '../../prompt/buildUserPayload.ts';

/** Failure taxonomy the orchestrator distinguishes (stage requirement 8). */
export type ProviderFailureKind =
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'TRANSPORT'
  | 'AUTH'
  | 'INVALID_REQUEST'
  | 'MALFORMED_OUTPUT'
  | 'SCHEMA_INVALID';

export interface ProviderCallMetrics {
  readonly interviewId: string | null;
  readonly mode: LLMMode;
  readonly provider: 'claude';
  readonly model: string;
  readonly promptVersion: string;
  readonly correlationId: string;
  readonly durationMs: number;
  readonly attempts: number;
  /** null when the provider did not report usage for this call. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly schemaValid: boolean;
  readonly failureKind?: ProviderFailureKind | undefined;
}

export interface ProviderResult {
  readonly kind: 'ok' | 'failed';
  readonly decision?: unknown;
  readonly errors?: string[];
  readonly failureKind?: ProviderFailureKind;
  readonly metrics: ProviderCallMetrics;
}

export interface MetricsSink {
  record(metrics: ProviderCallMetrics): void;
}

export interface ClaudeProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Transport-level retries inside the adapter (network, 5xx, 429, timeout). */
  readonly maxTransportRetries: number;
  /** Orchestrator-level corrective retry on a schema failure. */
  readonly maxSchemaRetries: number;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  /**
   * Sampling temperature. Current Claude models reject temperature/top_p/top_k
   * with a 400, so it is applied only to models that still accept it — see
   * MODELS_ACCEPTING_TEMPERATURE and docs/AMENDMENTS.md P1.
   */
  readonly temperature?: number | undefined;
}

/**
 * `LLMRequest.temperature` (API_CONTRACT.md v3 §3.1) predates the current model
 * family, which removed sampling parameters. Sending it to Opus 5 / Sonnet 5 /
 * Opus 4.7+ is a hard 400, so the adapter — whose documented job is provider
 * translation — omits it for those models rather than failing every call.
 */
const MODELS_ACCEPTING_TEMPERATURE = /^claude-(3|opus-4-5|opus-4-6|sonnet-4-5|sonnet-4-6|haiku-4-5)/;

export interface AnthropicLike {
  messages: {
    create(body: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };
}

interface MessageLike {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

const SCHEMA_BY_MODE = {
  initialization: initializationDecisionSchema,
  turn: turnDecisionSchema,
} as const;

export class ClaudeProvider {
  private readonly client: AnthropicLike;

  constructor(
    private readonly config: ClaudeProviderConfig,
    private readonly metrics?: MetricsSink | undefined,
    client?: AnthropicLike,
  ) {
    this.client =
      client ??
      (new Anthropic({
        apiKey: config.apiKey,
        timeout: config.timeoutMs,
        // Retries are handled explicitly below so each attempt is classified and
        // counted; the SDK's own retry loop would hide that from observability.
        maxRetries: 0,
      }) as unknown as AnthropicLike);
  }

  async generate(
    mode: LLMMode,
    payload: unknown,
    context?: { interviewId?: string | null; correlationId?: string },
  ): Promise<ProviderResult> {
    const started = Date.now();
    const correlationId = context?.correlationId ?? `req_${Math.random().toString(36).slice(2, 12)}`;
    const interviewId = context?.interviewId ?? null;
    let attempts = 0;
    let lastFailure: ProviderFailureKind = 'TRANSPORT';
    let lastErrors: string[] = [];
    let usage: { input: number | null; output: number | null } = { input: null, output: null };
    let correction: string[] | undefined;

    // Outer loop: one corrective retry after a schema failure (orchestrator-level
    // policy). Inner loop: transport retries (adapter-level policy). The two are
    // deliberately separate — a malformed decision is not a transport fault and
    // must not be retried blindly.
    for (let schemaAttempt = 0; schemaAttempt <= this.config.maxSchemaRetries; schemaAttempt += 1) {
      for (let transportAttempt = 0; transportAttempt <= this.config.maxTransportRetries; transportAttempt += 1) {
        attempts += 1;
        try {
          const raw = (await this.client.messages.create(
            this.buildRequest(mode, payload, correction),
          )) as MessageLike;

          usage = {
            input: raw.usage?.input_tokens ?? null,
            output: raw.usage?.output_tokens ?? null,
          };

          const text = this.extractText(raw);
          if (text === null) {
            lastFailure = 'MALFORMED_OUTPUT';
            lastErrors = ['provider returned no text content block'];
            break; // not a transport fault — go to the corrective retry
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            lastFailure = 'MALFORMED_OUTPUT';
            lastErrors = ['provider output was not valid JSON'];
            break;
          }

          // Independent re-validation. Even with provider-side structured output,
          // this is the actual correctness boundary.
          const validation = validateDecision(mode, parsed);
          if (!validation.valid) {
            lastFailure = 'SCHEMA_INVALID';
            lastErrors = validation.errors;
            break;
          }

          return this.succeed(parsed, {
            interviewId, mode, correlationId, started, attempts, usage,
          });
        } catch (err) {
          const kind = classifyError(err);
          lastFailure = kind;
          lastErrors = [errorMessage(err)];
          // Only transport-class faults are worth an immediate retry.
          if (kind !== 'TIMEOUT' && kind !== 'RATE_LIMIT' && kind !== 'TRANSPORT') break;
          if (transportAttempt < this.config.maxTransportRetries) {
            await delay(backoffMs(transportAttempt));
            continue;
          }
        }
      }

      // A schema/parse failure gets exactly one corrective retry, with the
      // validator's own errors appended to the payload as data.
      if (lastFailure === 'SCHEMA_INVALID' || lastFailure === 'MALFORMED_OUTPUT') {
        correction = lastErrors;
        continue;
      }
      break;
    }

    return this.fail(lastFailure, lastErrors, {
      interviewId, mode, correlationId, started, attempts, usage,
    });
  }

  private buildRequest(
    mode: LLMMode,
    payload: unknown,
    previousOutputErrors?: readonly string[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxOutputTokens,
      // The fixed, versioned prompt. It never contains candidate, CV, JD or
      // requirement text — all of that arrives in the user turn.
      system: SYSTEM_PROMPT_V1_1,
      messages: [
        {
          role: 'user',
          content: serializeUserTurn(payload as Record<string, unknown>, previousOutputErrors),
        },
      ],
      // Strongest supported structured-output mechanism: the canonical Ajv schema
      // is handed to the provider directly, so it is never weakened to suit the
      // provider.
      output_config: {
        format: { type: 'json_schema', schema: SCHEMA_BY_MODE[mode] },
        ...(this.config.effort ? { effort: this.config.effort } : {}),
      },
      // Adaptive thinking, with the reasoning itself never returned or stored —
      // only the contracted two-field operational_reasoning is persisted.
      thinking: { type: 'adaptive' },
    };

    if (this.config.temperature !== undefined && MODELS_ACCEPTING_TEMPERATURE.test(this.config.model)) {
      body.temperature = this.config.temperature;
    }
    return body;
  }

  private extractText(message: MessageLike): string | null {
    const blocks = message.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    return text.trim().length > 0 ? text : null;
  }

  private succeed(decision: unknown, ctx: MetricsContext): ProviderResult {
    const metrics = this.metricsFor(ctx, true, undefined);
    this.metrics?.record(metrics);
    return { kind: 'ok', decision, metrics };
  }

  private fail(kind: ProviderFailureKind, errors: string[], ctx: MetricsContext): ProviderResult {
    const metrics = this.metricsFor(ctx, false, kind);
    this.metrics?.record(metrics);
    return { kind: 'failed', errors, failureKind: kind, metrics };
  }

  private metricsFor(
    ctx: MetricsContext,
    schemaValid: boolean,
    failureKind: ProviderFailureKind | undefined,
  ): ProviderCallMetrics {
    const input = ctx.usage.input;
    const output = ctx.usage.output;
    return {
      interviewId: ctx.interviewId,
      mode: ctx.mode,
      provider: 'claude',
      model: this.config.model,
      promptVersion: PROMPT_VERSION,
      correlationId: ctx.correlationId,
      durationMs: Date.now() - ctx.started,
      attempts: ctx.attempts,
      // Recorded as null — "unavailable" — rather than fabricated when the
      // provider did not report usage.
      inputTokens: input,
      outputTokens: output,
      totalTokens: input !== null && output !== null ? input + output : null,
      schemaValid,
      failureKind,
    };
  }
}

interface MetricsContext {
  readonly interviewId: string | null;
  readonly mode: LLMMode;
  readonly correlationId: string;
  readonly started: number;
  readonly attempts: number;
  readonly usage: { input: number | null; output: number | null };
}

/** Maps SDK errors onto the taxonomy the orchestrator branches on. */
export function classifyError(err: unknown): ProviderFailureKind {
  const e = err as { status?: number; name?: string; message?: string };
  const name = e?.name ?? '';
  if (name === 'APIConnectionTimeoutError' || /timeout/i.test(e?.message ?? '')) return 'TIMEOUT';
  if (e?.status === 429 || name === 'RateLimitError') return 'RATE_LIMIT';
  if (e?.status === 401 || e?.status === 403 || name === 'AuthenticationError') return 'AUTH';
  if (typeof e?.status === 'number' && e.status >= 500) return 'TRANSPORT';
  if (e?.status === 400 || name === 'BadRequestError') return 'INVALID_REQUEST';
  return 'TRANSPORT';
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

const backoffMs = (attempt: number): number => Math.min(2000, 250 * 2 ** attempt);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
