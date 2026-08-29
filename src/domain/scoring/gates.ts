/**
 * Critical gate evaluation — SCORING_FRAMEWORK.md v3 §6 (B1, B2).
 *
 * B1: JobRequirement.criticalGate is the ONLY gate mechanism. Competencies are
 * never gates — CompetencyAssessment has no gate field at all, so no function
 * here accepts one.
 */
import { MVP_CALIBRATION_DEFAULTS } from '../../config/scoring.config.ts';
import type { JobRequirement, RequirementAssessment } from '../types/entities.ts';
import type { CriticalGateStatus, GateStatus } from '../types/enums.ts';

export interface GateInput {
  readonly requirement: JobRequirement;
  readonly assessment: RequirementAssessment;
  /** INTERVIEW_STATE.md v3 §5a — reached IN_PROGRESS and had >= 1 question asked. */
  readonly genuineAttempt: boolean;
}

/**
 * CLEARED   — clears gateClearanceMinScore with adequate evidence.
 * FAILED    — adequate evidence, but below the minimum.
 * INSUFFICIENT_DATA — never reached a genuineAttempt at all.
 * NOT_A_GATE — the requirement is not configured as a gate.
 */
export function evaluateGateStatus(input: GateInput): GateStatus {
  if (!input.requirement.criticalGate) return 'NOT_A_GATE';

  const adequate =
    input.genuineAttempt &&
    !input.assessment.insufficientEvidenceFlag &&
    input.assessment.score !== null;

  if (!adequate) return 'INSUFFICIENT_DATA';
  return (input.assessment.score as number) >= MVP_CALIBRATION_DEFAULTS.gateClearanceMinScore
    ? 'CLEARED'
    : 'FAILED';
}

/**
 * B2: aggregated across critical-gate JobRequirement rows ONLY. Says nothing
 * about MUST_HAVE rows that are not configured gates.
 *
 * INSUFFICIENT outranks FAILED in the summary because an untested gate is a
 * process failure, which §8.3 treats more severely than an evidenced one.
 */
export function aggregateCriticalGateStatus(
  statuses: readonly GateStatus[],
): CriticalGateStatus {
  const gates = statuses.filter((s) => s !== 'NOT_A_GATE');
  if (gates.some((s) => s === 'INSUFFICIENT_DATA')) return 'ONE_OR_MORE_INSUFFICIENT';
  if (gates.some((s) => s === 'FAILED')) return 'ONE_OR_MORE_FAILED';
  return 'ALL_CLEARED';
}
