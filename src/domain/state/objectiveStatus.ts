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
import { classifyGap } from '../gaps/classification.ts';
import type { EvidenceGap, InterviewObjective } from '../types/entities.ts';
import type { CoverageLevel, EvidenceStrength, ObjectiveStatus } from '../types/enums.ts';

export interface ObjectiveEvaluationInput {
  readonly objective: InterviewObjective;
  /** Rolled-up coverage for this objective's dimension. */
  readonly coverageLevel: CoverageLevel;
  /** Strengths of every persisted Evidence row for this objective. */
  readonly evidenceStrengths: readonly EvidenceStrength[];
  /**
   * EvidenceGap rows still OPEN for this objective, after the turn's updates were
   * reconciled and any auto-resolution applied (AMENDMENTS.md A5).
   */
  readonly openGaps: readonly EvidenceGap[];
  /** Questions asked against this objective. */
  readonly questionCount: number;
}

/** §5a — MVP default: PARTIALLY_COVERED alone never satisfies. */
const SUFFICIENT_COVERAGE: CoverageLevel = 'COVERED';

/**
 * Conditions 1-3: the substantive evidence bar, independent of any gap state.
 * Isolated because A5's auto-resolution is gated on exactly these three holding.
 *   1. rolled-up coverage reached the sufficient level
 *   2. at least one persisted Evidence row is not INSUFFICIENT
 *   3. targetEvidenceCount met, where one is meaningfully configured
 */
export function meetsSubstantiveCriteria(input: ObjectiveEvaluationInput): boolean {
  if (input.coverageLevel !== SUFFICIENT_COVERAGE) return false;

  const usable = input.evidenceStrengths.filter((s) => s !== 'INSUFFICIENT');
  if (usable.length === 0) return false;

  const target = input.objective.targetEvidenceCount;
  if (target > 0 && usable.length < target) return false;

  return true;
}

/** Condition 4 (A5): only an explicitly BLOCKING unresolved gap can hold an
 * objective back. Advisory gaps inform the interview; they never silently invert
 * an outcome the evidence already supports. */
export function hasBlockingGap(openGaps: readonly EvidenceGap[]): boolean {
  return openGaps.some((g) => g.status === 'OPEN' && classifyGap(g.gapType) === 'BLOCKING');
}

/**
 * All four conditions must hold. Evidence count alone is never sufficient.
 * Condition 4 is narrowed per AMENDMENTS.md A5 — see hasBlockingGap.
 */
export function meetsSatisfiedCriteria(input: ObjectiveEvaluationInput): boolean {
  return meetsSubstantiveCriteria(input) && !hasBlockingGap(input.openGaps);
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
