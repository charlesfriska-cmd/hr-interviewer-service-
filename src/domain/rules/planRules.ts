/**
 * Deterministic plan validation — ARCHITECTURE.md §12 step 8, C2 ref protocol.
 *
 * Pure. Runs after Ajv and before anything is persisted: schema-valid is never
 * trusted-to-apply.
 */
import type { CompetencyLayer, InterviewPhase } from '../types/enums.ts';

export interface ProposedObjective {
  readonly ref: string;
  readonly phase: InterviewPhase;
  readonly requirementIds: readonly string[];
  readonly competencyTag: string;
  readonly targetEvidenceCount: number;
}

export interface PlanValidationInput {
  readonly objectives: readonly ProposedObjective[];
  readonly firstQuestionRef: string;
  readonly knownRequirementIds: ReadonlySet<string>;
}

export type PlanValidation =
  | { readonly ok: false; readonly reason: PlanRejectionReason; readonly detail: string }
  | { readonly ok: true; readonly objectives: readonly NormalizedObjective[] };

export type PlanRejectionReason =
  | 'NO_OBJECTIVES'
  | 'DUPLICATE_OBJECTIVE_REF'
  | 'EMPTY_OBJECTIVE_REF'
  | 'UNKNOWN_FIRST_QUESTION_REF'
  | 'UNKNOWN_REQUIREMENT_ID'
  | 'CLOSING_PHASE_OBJECTIVE';

export interface NormalizedObjective extends ProposedObjective {
  readonly competencyLayer: CompetencyLayer;
  readonly targetEvidenceCountClamped: number;
}

/** Universal competency tags per INTERVIEW_FRAMEWORK.md §5. Anything else the
 * planner produces is a dynamically clustered position-specific dimension. */
const UNIVERSAL_TAGS: ReadonlySet<string> = new Set([
  'communication', 'problem_solving', 'collaboration', 'ownership',
  'adaptability', 'motivation', 'values_alignment',
]);

const clamp = (n: number): number => Math.min(4, Math.max(1, Math.trunc(n)));

export function validatePlan(input: PlanValidationInput): PlanValidation {
  if (input.objectives.length === 0) {
    return { ok: false, reason: 'NO_OBJECTIVES', detail: 'plan contained no objectives' };
  }

  const seen = new Set<string>();
  for (const o of input.objectives) {
    if (!o.ref || o.ref.trim() === '') {
      return { ok: false, reason: 'EMPTY_OBJECTIVE_REF', detail: 'objective ref was empty' };
    }
    if (seen.has(o.ref)) {
      return { ok: false, reason: 'DUPLICATE_OBJECTIVE_REF', detail: `duplicate ref ${o.ref}` };
    }
    seen.add(o.ref);

    for (const rid of o.requirementIds) {
      if (!input.knownRequirementIds.has(rid)) {
        return { ok: false, reason: 'UNKNOWN_REQUIREMENT_ID', detail: `unknown requirement ${rid}` };
      }
    }

    // A CLOSING objective can never be pursued: CLOSING -> COMPLETED always fires
    // and COMPLETE_INTERVIEW forces question = null. Reject rather than persist a
    // dead entry (AMENDMENTS.md O9).
    if (o.phase === 'CLOSING') {
      return { ok: false, reason: 'CLOSING_PHASE_OBJECTIVE', detail: `objective ${o.ref} assigned to CLOSING` };
    }
  }

  if (!seen.has(input.firstQuestionRef)) {
    return {
      ok: false,
      reason: 'UNKNOWN_FIRST_QUESTION_REF',
      detail: `first question references unknown objective ${input.firstQuestionRef}`,
    };
  }

  return {
    ok: true,
    objectives: input.objectives.map((o) => ({
      ...o,
      competencyLayer: UNIVERSAL_TAGS.has(o.competencyTag) ? 'UNIVERSAL' : 'POSITION_SPECIFIC',
      targetEvidenceCountClamped: clamp(o.targetEvidenceCount),
    })),
  };
}
