/**
 * Application ports — the seam between orchestration and everything with I/O.
 *
 * The pipeline depends only on these interfaces; no concrete database, HTTP
 * framework, or provider SDK is reachable from this layer (ARCHITECTURE.md §17).
 * Time and identity are ports rather than ambient calls, because TIME_EXHAUSTED,
 * the processing lease, and sequence numbering are all deterministic guarantees
 * that cannot otherwise be tested.
 */
import type {
  CandidateResponse,
  Evidence,
  EvidenceGap,
  Interview,
  InterviewObjective,
  InterviewState,
  ObjectiveId,
  Question,
} from '../../domain/types/entities.ts';
import type {
  ConfidenceBand,
  CoverageLevel,
  EvidenceStrength,
  ObjectiveStatus,
} from '../../domain/types/enums.ts';
import type { AuditIntent } from '../../domain/audit/auditIntent.ts';
import type { GapIntent } from '../../domain/gaps/reconcile.ts';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

/** Opaque transaction scope; repositories enlist in it when one is supplied. */
export interface TxScope {
  readonly id: string;
}

export interface UnitOfWork {
  run<T>(fn: (tx: TxScope) => Promise<T>): Promise<T>;
}

/**
 * API_CONTRACT.md v3 §5 — the six lookup outcomes are resolved here, including
 * B3's lease reclaim, so no caller branches on `status` itself.
 */
export type OperationClaim =
  | { readonly kind: 'proceed'; readonly operationId: string; readonly attempt: number; readonly resuming: boolean }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'terminal'; readonly status: number; readonly body: Record<string, unknown> | null };

export interface OperationStore {
  claim(input: {
    readonly scope: 'interview_response';
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly interviewId: string;
    readonly questionId: string;
  }): Promise<OperationClaim>;
  succeed(operationId: string, status: number, body: Record<string, unknown>, tx: TxScope): Promise<void>;
  fail(operationId: string, retryable: boolean): Promise<void>;
}

export interface InterviewRepository {
  load(interviewId: string): Promise<Interview | null>;
}

export interface InterviewStateRepository {
  load(interviewId: string): Promise<InterviewState | null>;
  /** Returns false on a version mismatch; the caller maps that to 409. */
  compareAndSwap(next: InterviewState, expectedVersion: number, tx: TxScope): Promise<boolean>;
}

export interface PlanRepository {
  objectives(interviewId: string): Promise<InterviewObjective[]>;
  /**
   * Objective ids linked to at least one MUST_HAVE requirement. The
   * PREMATURE_COMPLETION_BLOCKED guardrail is scoped to these specifically —
   * an unresolved objective carrying only NICE_TO_HAVE work must not hold the
   * interview open.
   */
  mustHaveObjectiveIds(interviewId: string): Promise<string[]>;
  setObjectiveStatus(
    interviewId: string,
    objectiveId: ObjectiveId,
    status: ObjectiveStatus,
    tx: TxScope,
  ): Promise<void>;
}

export interface QuestionRepository {
  load(questionId: string): Promise<Question | null>;
  insert(question: Question, tx: TxScope): Promise<void>;
  countForObjective(interviewId: string, objectiveId: ObjectiveId): Promise<number>;
}

export interface CandidateResponseRepository {
  /** Committed in its own short transaction, before the LLM is ever called. */
  insertDurable(response: CandidateResponse): Promise<void>;
  findByQuestion(questionId: string): Promise<CandidateResponse | null>;
}

export interface EvidenceRepository {
  insertMany(rows: readonly Evidence[], tx: TxScope): Promise<void>;
  strengthsForObjective(
    interviewId: string,
    objective: InterviewObjective,
  ): Promise<EvidenceStrength[]>;
}

export interface EvidenceGapRepository {
  openForObjective(interviewId: string, objectiveId: ObjectiveId): Promise<EvidenceGap[]>;
  apply(intents: readonly GapIntent[], interviewId: string, tx: TxScope): Promise<void>;
  autoResolve(gapIds: readonly string[], tx: TxScope): Promise<void>;
}

export interface AssessmentUpdate {
  readonly requirementId: string | null;
  readonly competencyTag: string;
  readonly coverageLevel: CoverageLevel;
  readonly confidenceBand: ConfidenceBand;
}

export interface AssessmentRepository {
  /**
   * C16 routing: a non-null requirementId updates BOTH the requirement rollup and
   * the linked competency rollup; null updates the competency rollup only.
   */
  applyUpdates(interviewId: string, updates: readonly AssessmentUpdate[], tx: TxScope): Promise<void>;
  coverageForObjective(
    interviewId: string,
    objective: InterviewObjective,
  ): Promise<CoverageLevel>;
}

export interface AuditWriter {
  write(interviewId: string, intents: readonly AuditIntent[], tx: TxScope): Promise<void>;
  /** For failures that commit outside the main transaction. */
  writeDetached(interviewId: string, intents: readonly AuditIntent[]): Promise<void>;
}

export interface LLMTurnResult {
  readonly kind: 'ok' | 'failed';
  readonly decision?: unknown;
  readonly errors?: string[];
}

export interface LLMGateway {
  /** Handles the corrective retry and transport retries internally. */
  runTurn(payload: unknown): Promise<LLMTurnResult>;
}

export interface SafetyScanner {
  /** Returns text with any denylisted term redacted, plus whether one matched. */
  scan(text: string): { readonly text: string; readonly matched: boolean };
}
