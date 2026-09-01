/**
 * Provider selection and configuration.
 *
 * Secrets come from the environment only. Selecting the real provider without
 * credentials fails at startup rather than at the first candidate turn; mock mode
 * requires no credentials at all.
 */
import { LLM_CONFIG_DEFAULTS } from './limits.config.ts';

export type ProviderName = 'mock' | 'claude';

export interface ResolvedProviderConfig {
  readonly provider: ProviderName;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxTransportRetries: number;
  readonly maxSchemaRetries: number;
  readonly maxOutputTokens: number;
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly temperature: number;
  /** Context truncation caps applied before any text reaches the provider. */
  readonly maxCvChars: number;
  readonly maxJdChars: number;
  readonly maxAnswerChars: number;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ProviderConfigError(`expected a number, got "${raw}"`);
  return n;
};

export function resolveProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderConfig {
  const provider = (env.LLM_PROVIDER ?? 'mock').toLowerCase();
  if (provider !== 'mock' && provider !== 'claude') {
    throw new ProviderConfigError(
      `LLM_PROVIDER must be "mock" or "claude", got "${env.LLM_PROVIDER}"`,
    );
  }

  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  if (provider === 'claude' && apiKey.trim() === '') {
    throw new ProviderConfigError(
      'LLM_PROVIDER=claude requires ANTHROPIC_API_KEY. Set it, or use LLM_PROVIDER=mock for credential-free local development.',
    );
  }

  return {
    provider,
    // Model is configuration, never hardcoded in the adapter.
    model: env.ANTHROPIC_MODEL ?? 'claude-opus-5',
    apiKey,
    timeoutMs: num(env.LLM_TIMEOUT_MS, LLM_CONFIG_DEFAULTS.timeoutMs),
    maxTransportRetries: num(env.LLM_MAX_TRANSPORT_RETRIES, LLM_CONFIG_DEFAULTS.maxTransportRetries),
    maxSchemaRetries: num(env.LLM_MAX_SCHEMA_RETRIES, LLM_CONFIG_DEFAULTS.maxSchemaRetries),
    // Adaptive thinking shares this ceiling, so it is sized well above the JSON
    // decision itself.
    maxOutputTokens: num(env.LLM_MAX_OUTPUT_TOKENS, 16_000),
    effort: (env.LLM_EFFORT as ResolvedProviderConfig['effort']) ?? 'high',
    temperature: num(env.LLM_TEMPERATURE, LLM_CONFIG_DEFAULTS.temperature),
    maxCvChars: num(env.LLM_MAX_CV_CHARS, 20_000),
    maxJdChars: num(env.LLM_MAX_JD_CHARS, 10_000),
    maxAnswerChars: num(env.LLM_MAX_ANSWER_CHARS, 6_000),
  };
}
