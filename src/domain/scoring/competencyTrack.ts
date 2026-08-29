/**
 * Competency Score track — SCORING_FRAMEWORK.md v3 §5.1.
 *
 * MUST NOT import requirementFit.ts. The two tracks are computed independently
 * and never numerically merged (C5); only recommendation.ts sees both, and it
 * consumes the requirement side purely as a cap.
 */
import { MVP_CALIBRATION_DEFAULTS } from '../../config/scoring.config.ts';
import type { CompetencyAssessment } from '../types/entities.ts';
import type { CompetencyLayer, ConfidenceBand } from '../types/enums.ts';
import { bandIndex, lowerBand } from './confidence.ts';

/**
 * B1 weight sourcing:
 *  - position-specific competencies ALWAYS 1.0 in MVP, regardless of the map;
 *  - universal competencies use universalCompetencyWeights, defaulting to 1.0.
 */
export function resolveCompetencyWeight(tag: string, layer: CompetencyLayer): number {
  if (layer === 'POSITION_SPECIFIC') return 1.0;
  return (
    MVP_CALIBRATION_DEFAULTS.universalCompetencyWeights[tag] ??
    MVP_CALIBRATION_DEFAULTS.defaultCompetencyWeight
  );
}

export interface CompetencyScoreResult {
  readonly competencyScore: number | null;
  readonly competencyConfidenceBand: ConfidenceBand;
}

/**
 * competencyScore = Sum(score x weight) / Sum(weight) over rows with score != null.
 *
 * Rows with score === null are excluded from BOTH numerator and denominator, so
 * an unevidenced competency never silently drags the average down; it surfaces
 * in unverifiedAreas instead.
 *
 * The aggregate confidence band is the weakest band among contributing rows —
 * an aggregate is no more trustworthy than its least-supported input.
 */
export function computeCompetencyScore(
  rows: readonly CompetencyAssessment[],
): CompetencyScoreResult {
  const scored = rows.filter((r) => r.score !== null);
  if (scored.length === 0) {
    return { competencyScore: null, competencyConfidenceBand: 'VERY_LOW' };
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const r of scored) {
    weighted += (r.score as number) * r.weight;
    totalWeight += r.weight;
  }
  if (totalWeight === 0) {
    return { competencyScore: null, competencyConfidenceBand: 'VERY_LOW' };
  }

  let band: ConfidenceBand = 'VERY_HIGH';
  for (const r of scored) band = lowerBand(band, r.confidenceBand);

  return {
    competencyScore: weighted / totalWeight,
    competencyConfidenceBand: band,
  };
}

/** Exposed for the no-blending test: proves nothing here reads requirement data. */
export const COMPETENCY_TRACK_INPUT_KEYS = ['score', 'weight', 'confidenceBand'] as const;

export { bandIndex };
