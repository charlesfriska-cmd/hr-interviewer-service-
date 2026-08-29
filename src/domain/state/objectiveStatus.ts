/**
 * Objective status lifecycle — INTERVIEW_STATE.md v3 §5a (B5).
 *
 *   PENDING -> IN_PROGRESS -> SATISFIED
 *                          -> INSUFFICIENT_EVIDENCE
 *
 * SATISFIED and INSUFFICIENT_EVIDENCE are terminal for the objective within this
 * interview. Evaluated deterministically against persisted data — it never trusts
 * the AI's coverage_level claim in isolation.
 */
import type { InterviewObjective } from '../types/entities.ts';
import type { CoverageLevel, EvidenceStrength, ObjectiveStatus } from '../types/enums.ts';

export interface ObjectiveEvaluationInput {
  readonly objective: InterviewObjective;
  /** Rolled-up coverage for this objective's dimension. */
  readonly coverageLevel: CoverageLevel;
  /** Strengths of every persisted Evidence row for this objective. */
  readonly evidenceStrengths: readonly EvidenceStrength[];
  /** Count of EvidenceGap rows still OPEN for this objective. */
  readonly openGapCount: number;
  /** Questions asked against this objective. */
  readonly questionCount: number;
}

/** §5a — MVP default: PARTIALLY_COVERED alone never satisfies. */
const SUFFICIENT_COVERAGE: CoverageLevel = 'COVERED';

/**
 * All four conditions must hold. Evidence count alone is never sufficient.
 *   1. rolled-up coverage reached the sufficient level
 *   2. at least one persisted Evidence row is not INSUFFICIENT
 *   3. targetEvidenceCount met, where one is meaningfully configured
 *   4. no EvidenceGap for this objective remains OPEN
 */
export function meetsSatisfiedCriteria(input: ObjectiveEvaluationInput): boolean {
  if (input.coverageLevel !== SUFFICIENT_COVERAGE) return false;

  const usable = input.evidenceStrengths.filter((s) => s !== 'INSUFFICIENT');
  if (usable.length === 0) return false;

  const target = input.objective.targetEvidenceCount;
  if (target > 0 && usable.length < target) return false;

  if (input.openGapCount > 0) return false;

  return true;
}

/**
 * §5a — an objective reaches IN_PROGRESS the instant its first candidate-facing
 * question is persisted (that question's presentedAt being set).
 */
export function onQuestionPresented(current: ObjectiveStatus): ObjectiveStatus {
  return current === 'PENDING' ? 'IN_PROGRESS' : current;
}

/** Evaluated after every successfully applied turn. */
export function afterAppliedTurn(input: ObjectiveEvaluationInput): ObjectiveStatus {
  const current = input.objective.status;
  if (current === 'SATISFIED' || current === 'INSUFFICIENT_EVIDENCE') return current;
  return meetsSatisfiedCriteria(input) ? 'SATISFIED' : 'IN_PROGRESS';
}

/**
 * Node.js closes out an objective without the SATISFIED criteria holding —
 * follow-up budget exhausted, a global guardrail fired, phase progression moved
 * past it (including the C9 forced-CLOSING path), or no usable evidence was ever
 * obtained.
 *
 * An objective genuinely never reached stays PENDING and is reported in
 * unverifiedAreas as "not reached" — distinct from one that was attempted.
 */
export function onObjectiveClosed(input: ObjectiveEvaluationInput): ObjectiveStatus {
  const current = input.objective.status;
  if (current === 'SATISFIED' || current === 'INSUFFICIENT_EVIDENCE') return current;
  if (current === 'PENDING') return 'PENDING';
  return meetsSatisfiedCriteria(input) ? 'SATISFIED' : 'INSUFFICIENT_EVIDENCE';
}

/**
 * §5a canonical definition. Feeds premature-completion protection,
 * unverifiedAreas phrasing, and the minimum-evidence exclusion in scoring.
 */
export function genuineAttempt(objective: InterviewObjective, questionCount: number): boolean {
  return objective.status !== 'PENDING' && questionCount >= 1;
}
