/**
 * The provider seam. Both the mock and the Claude adapter satisfy this, so
 * selection is a composition-root concern and no application module names a
 * concrete provider.
 */
import type { LLMMode } from '../schema/dispatch.ts';

export interface ProviderCallContext {
  readonly interviewId?: string | null;
  readonly correlationId?: string;
}

export interface ProviderOutcome {
  readonly kind: 'ok' | 'failed';
  readonly decision?: unknown | undefined;
  readonly errors?: string[] | undefined;
  /** Typed failure class; the orchestrator branches on it, the mock omits it. */
  readonly failureKind?: string | undefined;
  /** Safe call metadata. Present on the real adapter, absent on the mock. */
  readonly metrics?: unknown | undefined;
}

export interface InterviewerProvider {
  generate(mode: LLMMode, payload: unknown, context?: ProviderCallContext): Promise<ProviderOutcome>;
}
