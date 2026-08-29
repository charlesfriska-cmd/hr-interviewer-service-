/**
 * Confidence band ordering — SCORING_FRAMEWORK.md v3 §4 (B6).
 *
 * Bands form a total order. Every tier-selection and gate comparison in §8 uses
 * index comparison against this order — never string equality, and never the
 * numeric midpoint (which stays an internal sort/storage key).
 */
import { MVP_CALIBRATION_DEFAULTS } from '../../config/scoring.config.ts';
import type { ConfidenceBand } from '../types/enums.ts';

const ORDER = MVP_CALIBRATION_DEFAULTS.confidenceBandOrder;

export function bandIndex(band: ConfidenceBand): number {
  const i = ORDER.indexOf(band);
  if (i < 0) throw new Error(`Unknown confidence band: ${band}`);
  return i;
}

/** "band meets or exceeds minimum" — the §4 comparison, stated once. */
export function bandAtLeast(band: ConfidenceBand, minimum: ConfidenceBand): boolean {
  return bandIndex(band) >= bandIndex(minimum);
}

export function lowerBand(a: ConfidenceBand, b: ConfidenceBand): ConfidenceBand {
  return bandIndex(a) <= bandIndex(b) ? a : b;
}

/** Internal sort/storage key only — never surfaced as a fake-precise decimal. */
export function bandMidpoint(band: ConfidenceBand): number {
  return MVP_CALIBRATION_DEFAULTS.confidenceBandMidpoint[band];
}
