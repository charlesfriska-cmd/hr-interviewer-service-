/**
 * Persistent entity shapes — API_CONTRACT.md v3 §2, which supersedes
 * ARCHITECTURE.md §9 in full (v2 §9 defers to it explicitly).
 *
 * Authority tags from API_CONTRACT.md §1 appear as comments: [NODE] Node-owned,
 * [AI-REC] AI-proposed then validated, [DERIVED] computed, [CONFIG] configuration.
 */
import type {
  CompetencyLayer,
  CompetencyRating,
  ConfidenceBand,
  CoverageLevel,
  CriticalGateStatus,
  EvidenceGapType,
  EvidenceStrength,
  GapStatus,
  GateStatus,
  InterviewPhase,
  InterviewStatus,
  ObjectiveStatus,
  RequirementPriority,
  OverallRecommendation,
} from './enums.ts';

/**
 * Branded ids. C2 gives `ref` and canonical id two different meanings that share
 * the field name `objective_ref` across the two AI schemas; branding makes a
 * mix-up a compile error rather than a runtime mystery.
 */
export type ObjectiveId = string & { readonly __brand: 'ObjectiveId' };
export type ObjectiveRef = string & { readonly __brand: 'ObjectiveRef' };

export const asObjectiveId = (v: string): ObjectiveId => v as ObjectiveId;
export const asObjectiveRef = (v: string): ObjectiveRef => v as ObjectiveRef;

export interface Interview {
  readonly id: string; // [NODE][IMMUTABLE]
  readonly candidateId: string; // [NODE][IMMUTABLE]
  readonly positionId: string; // [NODE][IMMUTABLE]
  status: InterviewStatus; // [NODE]
  readonly createdAt: string; // [NODE][IMMUTABLE] — row creation, NOT interview start
  /** B4: set exactly once, at the first Question.presentedAt. */
  startedAt?: string; // [NODE]
  updatedAt: string; // [DERIVED]
  completedAt?: string; // [NODE]
  terminatedReason?: TerminatedReason; // [NODE]
  /** B4: bounds ACTIVE interview time, never wall-clock since createdAt. */
  readonly maxDurationMinutes: number; // [NODE][IMMUTABLE]
  readonly maxQuestions: number; // [NODE][IMMUTABLE]
  readonly maxFollowUpsPerObjective: number; // [NODE][IMMUTABLE]
  readonly maxCandidateResponseWindowSeconds: number; // [NODE][IMMUTABLE][CONFIG] — B4
  readonly sessionIdleTimeoutMinutes: number; // [NODE][IMMUTABLE][CONFIG] — B4
}

export type TerminatedReason =
  | 'SESSION_IDLE_EXPIRED'
  | 'MAX_DURATION_EXCEEDED'
  | 'MAX_QUESTIONS_EXCEEDED'
  | 'RECRUITER_TERMINATED';

export interface InterviewState {
  readonly interviewId: string; // [NODE][IMMUTABLE]
  currentPhase: InterviewStatus; // [NODE]
  currentObjectiveId: ObjectiveId | null; // [NODE]
  questionsAskedCount: number; // [DERIVED]
  followUpsByObjective: Record<string, number>; // [DERIVED]
  /** B4: sum of clamped turnActiveSeconds. This, not (now - startedAt), bounds duration. */
  elapsedActiveInterviewSeconds: number; // [DERIVED]
  /** B4: ACTIVE seconds only, attributed to the phase current when the question was asked. */
  phaseElapsedSeconds: Partial<Record<InterviewPhase, number>>; // [DERIVED]
  /** B4: idle-timeout evaluation only — never used for active-time math. */
  lastActivityAt: string; // [DERIVED]
  unresolvedGapIds: string[]; // [NODE] — references EvidenceGap rows
  lastQuestionId: string | null; // [NODE]
  version: number; // [NODE][DERIVED] — optimistic concurrency
  updatedAt: string; // [DERIVED]
}

export interface JobRequirement {
  readonly id: string; // [NODE][IMMUTABLE]
  readonly positionId: string; // [NODE][IMMUTABLE]
  readonly label: string; // [NODE][IMMUTABLE]
  readonly description: string; // [NODE][IMMUTABLE] — untrusted downstream
  /** A priority label ONLY. Never a gate (DOMAIN_GLOSSARY: MUST_HAVE). */
  readonly priority: RequirementPriority; // [NODE][IMMUTABLE]
  readonly competencyTag: string; // [NODE][IMMUTABLE]
  readonly recruiterWeight?: number; // [NODE] — default 1.0
  /** B1: the ONLY gate designation field in the entire system. Never AI-visible. */
  readonly criticalGate: boolean; // [NODE][IMMUTABLE]
}

export interface InterviewObjective {
  readonly id: ObjectiveId; // [NODE][IMMUTABLE] — canonical UUID, never AI-supplied
  readonly phase: InterviewPhase; // [AI-REC], validated
  readonly requirementIds: string[]; // [AI-REC], validated against sent requirements
  readonly competencyTag: string; // [AI-REC], registered into the interview's tag registry
  /** See docs/AMENDMENTS.md A3 — required to resolve competency weight under B1. */
  readonly competencyLayer: CompetencyLayer; // [AI-REC], closed enum
  readonly targetEvidenceCount: number; // [AI-REC], clamped 1–4
  status: ObjectiveStatus; // [NODE] — lifecycle in INTERVIEW_STATE.md v3 §5a
}

export interface Question {
  readonly id: string; // [NODE][IMMUTABLE]
  readonly interviewId: string; // [NODE][IMMUTABLE]
  readonly objectiveId: ObjectiveId; // [NODE][IMMUTABLE] — canonical UUID
  readonly phase: InterviewPhase; // [NODE][IMMUTABLE]
  readonly text: string; // [NODE][IMMUTABLE] — validated AI-authored question text
  /** B4: the turn's clock start; also the source of Interview.startedAt for question #1. */
  readonly presentedAt: string; // [NODE][IMMUTABLE]
  // Retained beyond API_CONTRACT v3 §2.8's restatement — see docs/AMENDMENTS.md A1.
  readonly sequenceNumber: number; // [DERIVED]
  readonly competencyTag: string | null; // [AI-REC]
  readonly questionType: string; // [AI-REC]
}

export interface CandidateResponse {
  readonly id: string; // [NODE][IMMUTABLE]
  readonly questionId: string; // [NODE][IMMUTABLE]
  readonly interviewId: string; // [NODE][IMMUTABLE]
  readonly answerText: string; // [NODE][IMMUTABLE] — untrusted, durable before any LLM call
  /** B4: set at the durable pre-LLM-call write; closes turnActiveSeconds. */
  readonly receivedAt: string; // [NODE][IMMUTABLE]
}

export interface Evidence {
  readonly id: string; // [NODE][IMMUTABLE]
  readonly interviewId: string; // [NODE][IMMUTABLE]
  readonly requirementId: string | null; // [AI-REC], validated
  readonly competencyTag: string; // [AI-REC], validated against the registry
  readonly sourceResponseId: string; // [NODE][IMMUTABLE] — never trusted from AI output
  readonly summary: string; // [AI-REC] — FACT-only; inference explicitly hedged
  readonly strength: EvidenceStrength; // [AI-REC]
  readonly createdAt: string; // [NODE][IMMUTABLE]
}

export interface EvidenceGap {
  readonly id: string; // [NODE][IMMUTABLE]
  readonly interviewId: string; // [NODE][IMMUTABLE]
  readonly objectiveId: ObjectiveId; // [NODE][IMMUTABLE]
  readonly gapType: EvidenceGapType; // [AI-REC], closed enum
  description: string; // [AI-REC] — refreshed in place while OPEN (C11 dedup)
  status: GapStatus; // [NODE]
  readonly createdAt: string; // [NODE][IMMUTABLE]
  resolvedAt: string | null; // [NODE]
}

export interface RequirementAssessment {
  readonly requirementId: string; // [NODE][IMMUTABLE]
  readonly interviewId: string; // [NODE][IMMUTABLE]
  coverageLevel: CoverageLevel; // [AI-REC] per turn
  score: number | null; // [DERIVED] 1–5, finalization only; Requirement Fit only
  confidenceBand: ConfidenceBand; // [DERIVED]
  confidenceScore: number; // [DERIVED] — internal sort key only
  evidenceIds: string[]; // [DERIVED]
  gapIds: string[]; // [DERIVED]
  insufficientEvidenceFlag: boolean; // [NODE] — forced by the closing rule
  /** Meaningful only when the linked JobRequirement.criticalGate is true (B1). */
  gateStatus: GateStatus; // [DERIVED]
  notes: string; // [DERIVED] — templated, no LLM pass (C8)
}

/** B1: carries NO gate fields. isCriticalGate and gateStatus are deleted entirely. */
export interface CompetencyAssessment {
  readonly competencyTag: string; // [NODE][IMMUTABLE]
  readonly interviewId: string; // [NODE][IMMUTABLE]
  coverageLevel: CoverageLevel; // [AI-REC] — C16
  rating: CompetencyRating; // [DERIVED] — threshold-derived (C7)
  score: number | null; // [DERIVED] 1–5, finalization only; Competency Score only
  confidenceBand: ConfidenceBand; // [DERIVED]
  confidenceScore: number; // [DERIVED]
  evidenceIds: string[]; // [DERIVED]
  gapIds: string[]; // [DERIVED]
  /** B1: 1.0 for position-specific in MVP; config value for universal. */
  weight: number; // [CONFIG]
  rationale: string; // [DERIVED] — templated (C8)
}

export interface FinalAssessment {
  readonly interviewId: string; // [NODE][IMMUTABLE]
  readonly scoringConfigVersion: string; // [NODE][IMMUTABLE] — B6
  competencyScore: number | null; // [DERIVED]
  competencyConfidenceBand: ConfidenceBand; // [DERIVED]
  competencyAssessments: CompetencyAssessment[]; // [DERIVED]
  requirementAssessments: RequirementAssessment[]; // [DERIVED]
  /** B2: renamed from mustHaveGateStatus; critical-gate requirements only. */
  criticalGateStatus: CriticalGateStatus; // [DERIVED]
  overallRecommendation: OverallRecommendation; // [DERIVED]
  overallConfidenceBand: ConfidenceBand; // [DERIVED]
  keyStrengths: string[]; // [DERIVED]
  concerns: string[]; // [DERIVED]
  unverifiedAreas: string[]; // [DERIVED]
  contradictions: Array<{ description: string; resolved: boolean }>; // [DERIVED]
  riskFlags: string[]; // [DERIVED]
  niceToHaveHighlights: string[]; // [DERIVED]
  recommendationRationale: string; // [DERIVED]
  readonly generatedAt: string; // [NODE][IMMUTABLE]
}
