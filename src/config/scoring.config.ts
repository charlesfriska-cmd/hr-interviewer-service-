/**
 * Scoring configuration — transcribed from SCORING_FRAMEWORK.md v3 §9.
 *
 * Every value here is an MVP calibration default, not a validated calibration.
 * Changing a value is a config change, never an architecture change. Each
 * FinalAssessment records SCORING_CONFIG_VERSION so a later recalibration never
 * silently reinterprets a historical result (API_CONTRACT.md v3 §2.9).
 *
 * Timing config (maxCandidateResponseWindowSeconds, sessionIdleTimeoutMinutes,
 * processingLeaseDurationSeconds) deliberately lives in limits.config.ts — this
 * module is scoring-only, per SCORING_FRAMEWORK.md v3 §9.
 */
import type {
  ConfidenceBand,
  CoverageLevel,
  EvidenceStrength,
  OverallRecommendation,
} from '../domain/types/enums.ts';

export const SCORING_CONFIG_VERSION = '1.1.0-mvp';

/** Scoreable strengths — INSUFFICIENT is excluded by design (it yields score = null). */
type ScoreableStrength = Exclude<EvidenceStrength, 'INSUFFICIENT'>;

/** Tiers participating in threshold selection; INSUFFICIENT_DATA is never tiered into. */
export type RecommendationTier = Exclude<OverallRecommendation, 'INSUFFICIENT_DATA'>;

export interface RecommendationTierConfig {
  readonly minCompetencyScore: number;
  readonly minConfidenceBand: ConfidenceBand;
}

export const MVP_CALIBRATION_DEFAULTS = {
  /** SCORING_FRAMEWORK.md v3 §9 / INTERVIEW_STATE.md v3 §8.1 — unchanged from v2. */
  evidenceScoreTable: {
    VERY_STRONG: { COVERED: 5, PARTIALLY_COVERED: 4, NOT_COVERED: 3 },
    STRONG: { COVERED: 4, PARTIALLY_COVERED: 3, NOT_COVERED: 2 },
    MODERATE: { COVERED: 3, PARTIALLY_COVERED: 2, NOT_COVERED: 2 },
    WEAK: { COVERED: 2, PARTIALLY_COVERED: 2, NOT_COVERED: 1 },
    VERY_WEAK: { COVERED: 1, PARTIALLY_COVERED: 1, NOT_COVERED: 1 },
    // INSUFFICIENT (or no evidence) => insufficientEvidenceFlag = true, score = null
  } satisfies Record<ScoreableStrength, Record<CoverageLevel, number>>,

  /** Internal sort/storage key only — never surfaced as a fake-precise decimal. */
  confidenceBandMidpoint: {
    VERY_LOW: 0.15,
    LOW: 0.4,
    MODERATE: 0.6,
    HIGH: 0.775,
    VERY_HIGH: 0.925,
  } satisfies Record<ConfidenceBand, number>,

  /** B6 — canonical total order backing every confidence comparison (§4/§8). */
  confidenceBandOrder: [
    'VERY_LOW',
    'LOW',
    'MODERATE',
    'HIGH',
    'VERY_HIGH',
  ] as readonly ConfidenceBand[],

  /** C7 — CompetencyAssessment.rating derivation, walked highest-first. */
  ratingThresholds: { STRONG: 4.0, ADEQUATE: 3.0, WEAK: 0.0 },

  /** B1 — weight sourcing. Position-specific competencies ALWAYS use 1.0 in MVP. */
  defaultCompetencyWeight: 1.0,
  universalCompetencyWeights: {} as Readonly<Record<string, number>>,
  // Recruiter-configurable position-specific competency weighting: DEFER_TO_POST_MVP (B1).

  /** SCORING_FRAMEWORK.md v3 §6 — a gated requirement clears at or above this score. */
  gateClearanceMinScore: 3.0,

  /**
   * §8.2 — walked top-down; BOTH conditions of a tier must hold or evaluation
   * continues downward. NOT_RECOMMENDED is the floor and is trivially satisfied
   * by any non-null score, by design.
   */
  recommendationTiers: {
    STRONGLY_RECOMMENDED: { minCompetencyScore: 4.3, minConfidenceBand: 'HIGH' },
    RECOMMENDED: { minCompetencyScore: 3.5, minConfidenceBand: 'MODERATE' },
    CONSIDER: { minCompetencyScore: 2.5, minConfidenceBand: 'LOW' },
    NOT_RECOMMENDED: { minCompetencyScore: 0.0, minConfidenceBand: 'VERY_LOW' },
  } satisfies Record<RecommendationTier, RecommendationTierConfig>,

  /** INTERVIEW_STATE.md v3 §4a — advisory only; never forces a transition (C15). */
  phaseSoftBudgetShare: {
    OPENING: 0.1,
    EXPERIENCE_VALIDATION: 0.25,
    COMPETENCY_DEEP_DIVE: 0.35,
    MOTIVATION_FIT: 0.15,
    CLARIFICATION: 0.15,
  },
} as const;

/**
 * Tier ordering, highest first. §8.2 walks this array; §8.4/§8.5 cap by taking
 * the lower of two tiers, which is the later entry in this array.
 */
export const RECOMMENDATION_TIER_ORDER: readonly RecommendationTier[] = [
  'STRONGLY_RECOMMENDED',
  'RECOMMENDED',
  'CONSIDER',
  'NOT_RECOMMENDED',
];
