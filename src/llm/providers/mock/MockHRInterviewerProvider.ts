/**
 * Mock HR Interviewer provider — no credentials, no network.
 *
 * Selected through the same composition point as a real adapter would be, so
 * tests exercise production wiring rather than a parallel graph. Scenarios cover
 * both call modes and every failure the contracts specify.
 */
import { validateDecision, type LLMMode } from '../../schema/dispatch.ts';

export class LLMTimeoutError extends Error {
  constructor() {
    super('provider timed out');
    this.name = 'LLMTimeoutError';
  }
}
export class LLMTransportError extends Error {
  constructor(message = 'provider transport error') {
    super(message);
    this.name = 'LLMTransportError';
  }
}

export interface ProviderResult {
  readonly kind: 'ok' | 'failed';
  readonly decision?: unknown;
  readonly errors?: string[];
}

/** A scripted step: either a payload to return, or a fault to raise. */
export type MockStep =
  | { readonly kind: 'respond'; readonly payload: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'transport'; readonly message?: string };

export interface MockProviderOptions {
  /** Steps consumed in order; the last is reused once exhausted. */
  readonly steps: readonly MockStep[];
  /** Adapter-level transport retries, matching the real adapter's policy. */
  readonly maxTransportRetries?: number;
}

export class MockHRInterviewerProvider {
  private index = 0;
  public calls: Array<{ mode: LLMMode; payload: unknown }> = [];

  constructor(private readonly opts: MockProviderOptions) {}

  /**
   * Mirrors the real adapter's contract: transport faults are retried here, and
   * the returned payload is always independently re-validated by the caller —
   * the provider's own guarantee is never the trust boundary.
   */
  async generate(mode: LLMMode, payload: unknown): Promise<ProviderResult> {
    this.calls.push({ mode, payload });
    const maxRetries = this.opts.maxTransportRetries ?? 2;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const step = this.nextStep();
      if (step.kind === 'respond') {
        const validation = validateDecision(mode, step.payload);
        return validation.valid
          ? { kind: 'ok', decision: step.payload }
          : { kind: 'failed', errors: validation.errors };
      }
      lastError = step.kind === 'timeout' ? new LLMTimeoutError() : new LLMTransportError(step.message);
    }
    return { kind: 'failed', errors: [lastError?.name ?? 'LLMTransportError'] };
  }

  private nextStep(): MockStep {
    const step = this.opts.steps[Math.min(this.index, this.opts.steps.length - 1)];
    this.index += 1;
    return step ?? { kind: 'transport' };
  }
}

// ------------------------------------------------------------------- fixtures

export const objective = (
  ref: string,
  over: Partial<{ phase: string; requirement_ids: string[]; competency_tag: string; target_evidence_count: number }> = {},
) => ({
  ref,
  phase: 'COMPETENCY_DEEP_DIVE',
  requirement_ids: [],
  competency_tag: 'system_design',
  target_evidence_count: 1,
  ...over,
});

/** 1. Successful initialization with 2. multiple objectives and 3. first-question mapping. */
export const initSuccess = (requirementIds: string[] = ['req_1', 'req_2']) => ({
  candidate_message: 'Thanks for joining today. To start, tell me about your current role.',
  objectives: [
    objective('obj_1', {
      phase: 'OPENING',
      competency_tag: 'communication',
      requirement_ids: [],
      target_evidence_count: 1,
    }),
    objective('obj_2', {
      phase: 'COMPETENCY_DEEP_DIVE',
      competency_tag: 'system_design',
      requirement_ids: requirementIds.slice(0, 1),
      target_evidence_count: 1,
    }),
    objective('obj_3', {
      phase: 'MOTIVATION_FIT',
      competency_tag: 'motivation',
      requirement_ids: requirementIds.slice(1, 2),
      target_evidence_count: 1,
    }),
  ],
  first_question: {
    objective_ref: 'obj_1',
    competency: 'communication',
    question_type: 'opening',
    text: 'Tell me about your current role.',
  },
  operational_reasoning: { objective: 'Establish context', evidence_gap: 'None yet' },
});

/** 4. Malformed: violates the schema (unknown enum value). */
export const initMalformed = (requirementIds?: string[]) => {
  const d = initSuccess(requirementIds) as Record<string, unknown>;
  (d.objectives as Array<Record<string, unknown>>)[0]!.phase = 'NOT_A_PHASE';
  return d;
};

/** 5. Duplicate local refs — schema-valid, caught by the deterministic ref check. */
export const initDuplicateRefs = (requirementIds?: string[]) => {
  const d = initSuccess(requirementIds) as Record<string, unknown>;
  (d.objectives as Array<Record<string, unknown>>)[1]!.ref = 'obj_1';
  return d;
};

/** 6. First question pointing at an unknown objective ref. */
export const initUnknownFirstQuestionRef = (requirementIds?: string[]) => {
  const d = initSuccess(requirementIds) as Record<string, unknown>;
  (d.first_question as Record<string, unknown>).objective_ref = 'obj_missing';
  return d;
};

/** Empty objective list — rejected by the deterministic plan rules. */
export const initNoObjectives = (requirementIds?: string[]) => ({
  ...initSuccess(requirementIds),
  objectives: [],
});

export const turnDecision = (over: Record<string, unknown> = {}) => ({
  status: 'in_progress',
  recommended_action: 'FOLLOW_UP',
  candidate_message: 'Thanks — could you say more about your own part in that?',
  question: {
    phase: 'COMPETENCY_DEEP_DIVE',
    objective: 'PLACEHOLDER',
    competency: 'system_design',
    question_type: 'behavioral_follow_up',
    text: 'What was your specific role versus the team’s?',
  },
  evidence_updates: [],
  assessment_updates: [],
  evidence_gap_updates: [],
  operational_reasoning: { objective: 'Establish ownership', evidence_gap: 'unclear' },
  contradiction_status: 'NONE',
  progress: { objectives_completed: 0, objectives_total: 3 },
  ...over,
});

export const TIMEOUT_STEP: MockStep = { kind: 'timeout' };
export const TRANSPORT_ERROR_STEP: MockStep = { kind: 'transport' };
