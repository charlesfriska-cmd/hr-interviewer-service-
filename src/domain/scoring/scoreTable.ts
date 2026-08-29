/**
 * Evidence strength x coverage -> 1-5 score — INTERVIEW_STATE.md v3 §8.1.
 *
 * Applied INDEPENDENTLY to requirement-linked and competency-linked evidence.
 * Two separate applications of one table, never a shared computation: that is
 * what makes C5's no-double-counting guarantee hold when a single Evidence row
 * carries both a requirementId and a competencyTag.
 */
import { MVP_CALIBRATION_DEFAULTS } from '../../config/scoring.config.ts';
import type { CoverageLevel, EvidenceStrength } from '../types/enums.ts';

export interface ScoreResult {
  readonly score: number | null;
  readonly insufficientEvidenceFlag: boolean;
}

const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  INSUFFICIENT: -1,
  VERY_WEAK: 0,
  WEAK: 1,
  MODERATE: 2,
  STRONG: 3,
  VERY_STRONG: 4,
};

/**
 * Highest strength attained across the supplied evidence, ignoring INSUFFICIENT
 * (which signals absence of usable evidence, not a low quality point).
 */
export function highestUsableStrength(
  strengths: readonly EvidenceStrength[],
): Exclude<EvidenceStrength, 'INSUFFICIENT'> | null {
  let best: Exclude<EvidenceStrength, 'INSUFFICIENT'> | null = null;
  for (const s of strengths) {
    if (s === 'INSUFFICIENT') continue;
    if (best === null || STRENGTH_RANK[s] > STRENGTH_RANK[best]) best = s;
  }
  return best;
}

/**
 * Zero evidence, or only INSUFFICIENT evidence, yields score = null and forces
 * insufficientEvidenceFlag — the table is not applied at all. Absence of evidence
 * never produces a low score (SCORING_FRAMEWORK.md §2 hard rule).
 */
export function computeScore(
  strengths: readonly EvidenceStrength[],
  coverage: CoverageLevel,
): ScoreResult {
  const best = highestUsableStrength(strengths);
  if (best === null) return { score: null, insufficientEvidenceFlag: true };
  return {
    score: MVP_CALIBRATION_DEFAULTS.evidenceScoreTable[best][coverage],
    insufficientEvidenceFlag: false,
  };
}
