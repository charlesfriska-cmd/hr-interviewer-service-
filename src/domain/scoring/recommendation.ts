/**
 * Deterministic overall-recommendation algorithm — SCORING_FRAMEWORK.md v3 §8 (B6).
 *
 * This is the canonical algorithm; no other module restates it. No LLM call is
 * involved at any point. Every branch below maps to a numbered step in §8.
 *
 * This is the ONLY module permitted to see both scoring tracks, and it consumes
 * the requirement side purely as a cap — never as a numeric contribution (C5).
 */
import {
  MVP_CALIBRATION_DEFAULTS,
  RECOMMENDATION_TIER_ORDER,
  type RecommendationTier,
} from '../../config/scoring.config.ts';
import type { JobRequirement, RequirementAssessment } from '../types/entities.ts';
import type { ConfidenceBand, GateStatus, OverallRecommendation } from '../types/enums.ts';
import { bandAtLeast } from './confidence.ts';

export interface RequirementOutcome {
  readonly requirement: JobRequirement;
  readonly assessment: RequirementAssessment;
  readonly gateStatus: GateStatus;
  /** INTERVIEW_STATE.md v3 §5a. */
  readonly genuineAttempt: boolean;
}

export interface RecommendationInput {
  readonly competencyScore: number | null;
  readonly competencyConfidenceBand: ConfidenceBand;
  readonly requirementOutcomes: readonly RequirementOutcome[];
}

export interface RecommendationResult {
  readonly overallRecommendation: OverallRecommendation;
  readonly riskFlags: string[];
  readonly concerns: string[];
}

/** Capping only ever lowers or leaves unchanged, never raises (§8.4). */
function lowerTier(a: RecommendationTier, b: RecommendationTier): RecommendationTier {
  return RECOMMENDATION_TIER_ORDER.indexOf(a) >= RECOMMENDATION_TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * §8.2 — walk tiers top-down; a tier is selected only when BOTH its score and its
 * confidence condition hold. If a higher tier's score passes but its confidence
 * does not, evaluation continues downward rather than awarding the higher tier or
 * treating the candidate as unscored.
 */
function selectBaseTier(
  competencyScore: number,
  band: ConfidenceBand,
): RecommendationTier {
  for (const tier of RECOMMENDATION_TIER_ORDER) {
    const cfg = MVP_CALIBRATION_DEFAULTS.recommendationTiers[tier];
    if (competencyScore >= cfg.minCompetencyScore && bandAtLeast(band, cfg.minConfidenceBand)) {
      return tier;
    }
  }
  return 'NOT_RECOMMENDED';
}

export function computeOverallRecommendation(
  input: RecommendationInput,
): RecommendationResult {
  const riskFlags: string[] = [];
  const concerns: string[] = [];

  const gates = input.requirementOutcomes.filter((o) => o.requirement.criticalGate);

  // ---- §8.3 — critical-gate INSUFFICIENT_DATA hard override, checked BEFORE capping.
  // A hard override rather than a cap: an untested non-negotiable requirement must
  // never be presented under a positive-flavoured tier, even CONSIDER.
  const untestedGates = gates.filter((o) => o.gateStatus === 'INSUFFICIENT_DATA');
  if (untestedGates.length > 0) {
    for (const g of untestedGates) {
      riskFlags.push(`Critical gate '${g.requirement.label}' never reached adequate evidence`);
    }
    return { overallRecommendation: 'INSUFFICIENT_DATA', riskFlags, concerns };
  }

  // ---- §8.2 — base tier. A null competencyScore is itself a material-insufficiency
  // case: no competency ever reached adequate evidence, so there is no scoreable
  // basis for any tier. DOMAIN_GLOSSARY defines INSUFFICIENT_DATA as exactly this
  // process outcome. See docs/AMENDMENTS.md A2.
  if (input.competencyScore === null) {
    riskFlags.push('No competency reached adequate evidence; interview did not produce a scoreable basis');
    return { overallRecommendation: 'INSUFFICIENT_DATA', riskFlags, concerns };
  }

  let tier = selectBaseTier(input.competencyScore, input.competencyConfidenceBand);

  // ---- §8.4 — critical-gate FAILED capping.
  const failedGates = gates.filter((o) => o.gateStatus === 'FAILED');
  for (const g of failedGates) {
    riskFlags.push(`Critical gate '${g.requirement.label}' failed`);
  }
  if (failedGates.length > 0) tier = lowerTier(tier, 'CONSIDER');

  // ---- §8.5 — material MUST_HAVE (non-gate) insufficiency capping.
  // Material = criticalGate OR MUST_HAVE, excluding rows already handled as gates.
  const materialNonGate = input.requirementOutcomes.filter(
    (o) =>
      !o.requirement.criticalGate &&
      o.requirement.priority === 'MUST_HAVE' &&
      (o.assessment.insufficientEvidenceFlag || !o.genuineAttempt),
  );
  for (const m of materialNonGate) {
    concerns.push(`${m.requirement.label} (MUST_HAVE) was not sufficiently evidenced`);
  }
  if (materialNonGate.length > 0) tier = lowerTier(tier, 'CONSIDER');

  // ---- §8.6 — no Nice-to-Have data is consulted anywhere above (C6).
  // ---- §8.7 — the surviving tier.
  return { overallRecommendation: tier, riskFlags, concerns };
}
