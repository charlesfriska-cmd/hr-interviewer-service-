/**
 * Canonical enums — API_CONTRACT.md v3 (shapes) and DOMAIN_GLOSSARY.md (meanings).
 *
 * Each enum is declared ONCE as an `as const` array. The TypeScript union and the
 * Ajv schema's `enum` both derive from that array, so the class of prompt/schema/
 * type drift that C3 exposed cannot recur silently.
 */

export const INTERVIEW_STATUS = [
  'INITIALIZING',
  'PRE_INTERVIEW_ANALYSIS',
  'OPENING',
  'EXPERIENCE_VALIDATION',
  'COMPETENCY_DEEP_DIVE',
  'MOTIVATION_FIT',
  'CLARIFICATION',
  'CLOSING',
  'COMPLETED',
  'TERMINATED',
  'ERROR',
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUS)[number];

/** The subset a question or objective can legitimately attach to. */
export const INTERVIEW_PHASE = [
  'OPENING',
  'EXPERIENCE_VALIDATION',
  'COMPETENCY_DEEP_DIVE',
  'MOTIVATION_FIT',
  'CLARIFICATION',
  'CLOSING',
] as const;
export type InterviewPhase = (typeof INTERVIEW_PHASE)[number];

export const RECOMMENDED_ACTION = [
  'FOLLOW_UP',
  'CLARIFY',
  'DEEP_DIVE',
  'MOVE_NEXT',
  'COMPLETE_INTERVIEW',
] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTION)[number];

/**
 * DOMAIN_GLOSSARY: INSUFFICIENT means no usable evidence was obtained at all —
 * it is not the bottom of the quality scale, it is a different kind of state.
 */
export const EVIDENCE_STRENGTH = [
  'VERY_WEAK',
  'WEAK',
  'MODERATE',
  'STRONG',
  'VERY_STRONG',
  'INSUFFICIENT',
] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTH)[number];

export const COVERAGE_LEVEL = ['COVERED', 'PARTIALLY_COVERED', 'NOT_COVERED'] as const;
export type CoverageLevel = (typeof COVERAGE_LEVEL)[number];

/** Ordered lowest to highest — the canonical total order is asserted in scoring/confidence.ts. */
export const CONFIDENCE_BAND = ['VERY_LOW', 'LOW', 'MODERATE', 'HIGH', 'VERY_HIGH'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BAND)[number];

export const EVIDENCE_GAP_TYPE = [
  'CONTEXT',
  'RESPONSIBILITY',
  'PERSONAL_CONTRIBUTION',
  'ACTION',
  'RESULT',
  'MEASURABLE_OUTCOME',
  'TECHNICAL_DEPTH',
  'DECISION_RATIONALE',
  'CONTRADICTION',
  'OTHER',
] as const;
export type EvidenceGapType = (typeof EVIDENCE_GAP_TYPE)[number];

export const GAP_STATUS = ['OPEN', 'RESOLVED'] as const;
export type GapStatus = (typeof GAP_STATUS)[number];

export const OBJECTIVE_STATUS = [
  'PENDING',
  'IN_PROGRESS',
  'SATISFIED',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUS)[number];

export const REQUIREMENT_PRIORITY = ['MUST_HAVE', 'NICE_TO_HAVE'] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITY)[number];

/**
 * B1: only JobRequirement can gate. CompetencyAssessment carries no gate field
 * at all — not "always NOT_A_GATE", the field does not exist on that entity.
 */
export const GATE_STATUS = ['NOT_A_GATE', 'CLEARED', 'FAILED', 'INSUFFICIENT_DATA'] as const;
export type GateStatus = (typeof GATE_STATUS)[number];

/** B2: renamed from mustHaveGateStatus; computed over critical-gate requirements only. */
export const CRITICAL_GATE_STATUS = [
  'ALL_CLEARED',
  'ONE_OR_MORE_FAILED',
  'ONE_OR_MORE_INSUFFICIENT',
] as const;
export type CriticalGateStatus = (typeof CRITICAL_GATE_STATUS)[number];

export const OVERALL_RECOMMENDATION = [
  'STRONGLY_RECOMMENDED',
  'RECOMMENDED',
  'CONSIDER',
  'NOT_RECOMMENDED',
  'INSUFFICIENT_DATA',
] as const;
export type OverallRecommendation = (typeof OVERALL_RECOMMENDATION)[number];

export const COMPETENCY_RATING = ['STRONG', 'ADEQUATE', 'WEAK', 'INSUFFICIENT_EVIDENCE'] as const;
export type CompetencyRating = (typeof COMPETENCY_RATING)[number];

/**
 * DOMAIN_GLOSSARY distinguishes these two kinds, and B1's weight sourcing depends
 * on which a competency is. See docs/AMENDMENTS.md A3 — no specification field
 * currently records the kind, so this discriminator is carried on the objective.
 */
export const COMPETENCY_LAYER = ['UNIVERSAL', 'POSITION_SPECIFIC'] as const;
export type CompetencyLayer = (typeof COMPETENCY_LAYER)[number];

export const CONTRADICTION_STATUS = ['NONE', 'RESOLVED', 'UNRESOLVED'] as const;
export type ContradictionStatus = (typeof CONTRADICTION_STATUS)[number];

export const OPERATION_STATUS = [
  'PROCESSING',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
] as const;
export type OperationStatus = (typeof OPERATION_STATUS)[number];

export const OPERATION_SCOPE = ['interview_create', 'interview_response'] as const;
export type OperationScope = (typeof OPERATION_SCOPE)[number];
