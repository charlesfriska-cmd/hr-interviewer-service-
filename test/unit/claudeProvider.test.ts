import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeProvider,
  classifyError,
  type AnthropicLike,
  type ClaudeProviderConfig,
  type ProviderCallMetrics,
} from '../../src/llm/providers/claude/ClaudeProvider.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT_V1_1 } from '../../src/llm/prompt/systemPrompt.v1_1.ts';
import { initSuccess, turnDecision } from '../../src/llm/providers/mock/MockHRInterviewerProvider.ts';

const CONFIG: ClaudeProviderConfig = {
  apiKey: 'test-key',
  model: 'claude-opus-5',
  maxOutputTokens: 16_000,
  timeoutMs: 60_000,
  maxTransportRetries: 2,
  maxSchemaRetries: 1,
  effort: 'high',
  temperature: 0.3,
};

/** A stand-in for the SDK client: no network, no credentials. */
class FakeSdk implements AnthropicLike {
  public requests: Array<Record<string, unknown>> = [];
  private i = 0;
  constructor(private readonly steps: Array<() => unknown>) {}
  messages = {
    create: async (body: Record<string, unknown>): Promise<unknown> => {
      this.requests.push(body);
      const step = this.steps[Math.min(this.i, this.steps.length - 1)];
      this.i += 1;
      return step!();
    },
  };
}

const textReply = (payload: unknown, usage = { input_tokens: 1200, output_tokens: 340 }) => () => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  usage,
  stop_reason: 'end_turn',
});

const raises = (err: unknown) => () => {
  throw err;
};
const apiError = (status: number, name: string) => Object.assign(new Error(name), { status, name });

const collector = () => {
  const recorded: ProviderCallMetrics[] = [];
  return { sink: { record: (m: ProviderCallMetrics) => recorded.push(m) }, recorded };
};

const provider = (steps: Array<() => unknown>, cfg: Partial<ClaudeProviderConfig> = {}) => {
  const sdk = new FakeSdk(steps);
  const { sink, recorded } = collector();
  return { p: new ClaudeProvider({ ...CONFIG, ...cfg }, sink, sdk), sdk, recorded };
};

const TURN = { ...turnDecision(), question: { ...turnDecision().question, objective: 'obj-1' } };

describe('request construction', () => {
  it('sends the approved v1.1 prompt verbatim as the system prompt', async () => {
    const { p, sdk } = provider([textReply(initSuccess())]);
    await p.generate('initialization', { hello: 'world' });
    expect(sdk.requests[0]!.system).toBe(SYSTEM_PROMPT_V1_1);
  });

  it('never places untrusted content in the system prompt', async () => {
    const { p, sdk } = provider([textReply(initSuccess())]);
    await p.generate('initialization', {
      untrusted: { candidate: { cvText: 'SECRET_CV_MARKER' } },
    });
    expect(sdk.requests[0]!.system).not.toContain('SECRET_CV_MARKER');
    // It reaches the model only as a JSON string value in the user turn.
    const messages = sdk.requests[0]!.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toContain('SECRET_CV_MARKER');
  });

  it('dispatches the canonical schema for the mode, unweakened', async () => {
    const { p, sdk } = provider([textReply(initSuccess()), textReply(TURN)]);
    await p.generate('initialization', {});
    await p.generate('turn', {});
    const first = sdk.requests[0]!.output_config as { format: { type: string; schema: Record<string, unknown> } };
    const second = sdk.requests[1]!.output_config as { format: { schema: Record<string, unknown> } };
    expect(first.format.type).toBe('json_schema');
    expect(first.format.schema.$id).toContain('initialization-decision');
    expect(second.format.schema.$id).toContain('turn-decision');
    expect(first.format.schema.additionalProperties).toBe(false);
  });

  it('omits temperature on models that reject sampling parameters (AMENDMENTS P1)', async () => {
    const { p, sdk } = provider([textReply(initSuccess())]);
    await p.generate('initialization', {});
    expect(sdk.requests[0]).not.toHaveProperty('temperature');
  });

  it('still sends temperature on a model that accepts it', async () => {
    const { p, sdk } = provider([textReply(initSuccess())], { model: 'claude-sonnet-4-6' });
    await p.generate('initialization', {});
    expect(sdk.requests[0]!.temperature).toBe(0.3);
  });

  it('does not request or return private reasoning', async () => {
    const { p, sdk } = provider([textReply(initSuccess())]);
    await p.generate('initialization', {});
    const thinking = sdk.requests[0]!.thinking as { type: string; display?: string };
    expect(thinking.type).toBe('adaptive');
    // display defaults to omitted — the raw chain of thought is never surfaced.
    expect(thinking.display).toBeUndefined();
  });
});

describe('initialization outcomes', () => {
  it('returns a validated InitializationDecision', async () => {
    const { p } = provider([textReply(initSuccess())]);
    const r = await p.generate('initialization', {});
    expect(r.kind).toBe('ok');
    expect((r.decision as { objectives: unknown[] }).objectives).toHaveLength(3);
  });

  it('rejects malformed JSON after a corrective retry', async () => {
    const { p, sdk } = provider([() => ({ content: [{ type: 'text', text: 'not json{' }] })]);
    const r = await p.generate('initialization', {});
    expect(r.kind).toBe('failed');
    expect(r.failureKind).toBe('MALFORMED_OUTPUT');
    // Exactly one corrective retry, carrying the errors as payload data.
    expect(sdk.requests).toHaveLength(2);
    expect(sdk.requests[1]!.system).toBe(SYSTEM_PROMPT_V1_1);
    expect(String((sdk.requests[1]!.messages as Array<{ content: string }>)[0]!.content))
      .toContain('previousOutputErrors');
  });

  it('rejects a schema-invalid objective', async () => {
    const bad = initSuccess() as Record<string, unknown>;
    (bad.objectives as Array<Record<string, unknown>>)[0]!.phase = 'NOT_A_PHASE';
    const { p } = provider([textReply(bad)]);
    const r = await p.generate('initialization', {});
    expect(r.kind).toBe('failed');
    expect(r.failureKind).toBe('SCHEMA_INVALID');
    expect(r.errors!.join(' ')).toContain('phase');
  });

  it('classifies a timeout', async () => {
    const { p } = provider([raises(apiError(0, 'APIConnectionTimeoutError'))]);
    const r = await p.generate('initialization', {});
    expect(r.failureKind).toBe('TIMEOUT');
  });

  it('classifies a rate limit and retries it', async () => {
    const { p, sdk } = provider([raises(apiError(429, 'RateLimitError')), textReply(initSuccess())]);
    const r = await p.generate('initialization', {});
    expect(r.kind).toBe('ok');
    expect(sdk.requests).toHaveLength(2);
  });

  it('gives up after the configured transport retries', async () => {
    const { p, sdk } = provider([raises(apiError(503, 'InternalServerError'))]);
    const r = await p.generate('initialization', {});
    expect(r.kind).toBe('failed');
    expect(r.failureKind).toBe('TRANSPORT');
    expect(sdk.requests).toHaveLength(3); // 1 attempt + 2 retries
  });

  it('does not retry a non-retryable request error', async () => {
    const { p, sdk } = provider([raises(apiError(400, 'BadRequestError'))]);
    const r = await p.generate('initialization', {});
    expect(r.failureKind).toBe('INVALID_REQUEST');
    expect(sdk.requests).toHaveLength(1);
  });

  it('does not retry an auth error', async () => {
    const { p, sdk } = provider([raises(apiError(401, 'AuthenticationError'))]);
    const r = await p.generate('initialization', {});
    expect(r.failureKind).toBe('AUTH');
    expect(sdk.requests).toHaveLength(1);
  });
});

describe('turn outcomes', () => {
  const withAction = (action: string, extra: Record<string, unknown> = {}) => ({
    ...TURN,
    recommended_action: action,
    ...extra,
  });

  for (const action of ['FOLLOW_UP', 'CLARIFY', 'DEEP_DIVE', 'MOVE_NEXT']) {
    it(`accepts a valid ${action}`, async () => {
      const { p } = provider([textReply(withAction(action))]);
      const r = await p.generate('turn', {});
      expect(r.kind).toBe('ok');
      expect((r.decision as { recommended_action: string }).recommended_action).toBe(action);
    });
  }

  it('accepts COMPLETE_INTERVIEW with a null question', async () => {
    const { p } = provider([textReply(withAction('COMPLETE_INTERVIEW', { question: null, status: 'complete' }))]);
    const r = await p.generate('turn', {});
    expect(r.kind).toBe('ok');
  });

  it('rejects a forbidden numeric score field', async () => {
    const { p } = provider([textReply({ ...TURN, competency_score: 5 })]);
    const r = await p.generate('turn', {});
    expect(r.kind).toBe('failed');
    expect(r.failureKind).toBe('SCHEMA_INVALID');
  });

  it('rejects a forbidden competency gate field', async () => {
    const bad = structuredClone(TURN) as Record<string, unknown>;
    (bad.assessment_updates as unknown[]).push({
      requirement_id: null, competency: 'x', coverage_level: 'COVERED',
      confidence_band: 'HIGH', is_critical_gate: true,
    });
    const { p } = provider([textReply(bad)]);
    const r = await p.generate('turn', {});
    expect(r.failureKind).toBe('SCHEMA_INVALID');
  });

  it('rejects an invalid enum value', async () => {
    const bad = structuredClone(TURN) as Record<string, unknown>;
    (bad.evidence_updates as unknown[]).push({
      requirement_id: null, competency: 'x', summary: 'y', strength: 'EXCELLENT',
    });
    const { p } = provider([textReply(bad)]);
    expect((await p.generate('turn', {})).failureKind).toBe('SCHEMA_INVALID');
  });

  it('rejects a missing required field', async () => {
    const bad = structuredClone(TURN) as Record<string, unknown>;
    delete bad.contradiction_status;
    const { p } = provider([textReply(bad)]);
    expect((await p.generate('turn', {})).failureKind).toBe('SCHEMA_INVALID');
  });

  it('never returns a decision when validation failed', async () => {
    const { p } = provider([textReply({ ...TURN, competency_score: 5 })]);
    const r = await p.generate('turn', {});
    expect(r.decision).toBeUndefined();
  });
});

describe('observability', () => {
  it('records safe metadata and no candidate content', async () => {
    const { p, recorded } = provider([textReply(TURN)]);
    await p.generate('turn', { untrusted: { latestAnswer: 'SECRET_ANSWER' } }, {
      interviewId: 'int_1', correlationId: 'corr_1',
    });
    const m = recorded[0]!;
    expect(m).toMatchObject({
      interviewId: 'int_1', mode: 'turn', provider: 'claude',
      model: 'claude-opus-5', promptVersion: PROMPT_VERSION,
      correlationId: 'corr_1', attempts: 1, schemaValid: true,
      inputTokens: 1200, outputTokens: 340, totalTokens: 1540,
    });
    expect(JSON.stringify(m)).not.toContain('SECRET_ANSWER');
  });

  it('records token usage as unavailable rather than fabricating it', async () => {
    const { p, recorded } = provider([
      () => ({ content: [{ type: 'text', text: JSON.stringify(TURN) }] }),
    ]);
    await p.generate('turn', {});
    expect(recorded[0]!.inputTokens).toBeNull();
    expect(recorded[0]!.totalTokens).toBeNull();
  });

  it('records the failure class and retry count on failure', async () => {
    const { p, recorded } = provider([raises(apiError(429, 'RateLimitError'))]);
    await p.generate('turn', {});
    expect(recorded[0]).toMatchObject({ schemaValid: false, failureKind: 'RATE_LIMIT', attempts: 3 });
  });
});

describe('error classification', () => {
  it('maps SDK errors onto the orchestrator taxonomy', () => {
    expect(classifyError(apiError(429, 'RateLimitError'))).toBe('RATE_LIMIT');
    expect(classifyError(apiError(500, 'InternalServerError'))).toBe('TRANSPORT');
    expect(classifyError(apiError(400, 'BadRequestError'))).toBe('INVALID_REQUEST');
    expect(classifyError(apiError(403, 'PermissionDeniedError'))).toBe('AUTH');
    expect(classifyError(new Error('socket timeout'))).toBe('TIMEOUT');
  });
});
