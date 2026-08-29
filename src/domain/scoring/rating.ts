/**
 * CompetencyAssessment.rating derivation — SCORING_FRAMEWORK.md v3 §2a (C7).
 *
 * Thresholds are walked highest-first and compared with >=; never an exact-value
 * switch. score === null always maps to INSUFFICIENT_EVIDENCE regardless of the
 * threshold values.
 */
import { MVP_CALIBRATION_DEFAULTS } from '../../config/scoring.config.ts';
import type { CompetencyRating } from '../types/enums.ts';

const ORDERED: ReadonlyArray<readonly [Exclude<CompetencyRating, 'INSUFFICIENT_EVIDENCE'>, number]> =
  [
    ['STRONG', MVP_CALIBRATION_DEFAULTS.ratingThresholds.STRONG],
    ['ADEQUATE', MVP_CALIBRATION_DEFAULTS.ratingThresholds.ADEQUATE],
    ['WEAK', MVP_CALIBRATION_DEFAULTS.ratingThresholds.WEAK],
  ];

export function deriveRating(score: number | null): CompetencyRating {
  if (score === null) return 'INSUFFICIENT_EVIDENCE';
  for (const [rating, min] of ORDERED) {
    if (score >= min) return rating;
  }
  return 'WEAK';
}
