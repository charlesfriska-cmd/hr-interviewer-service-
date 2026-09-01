/**
 * Deterministic narrative templates — SCORING_FRAMEWORK.md v3 §10 (C8).
 *
 * No LLM call is involved. Each field is assembled from already-persisted,
 * already-validated data, which keeps the narrative evidence-traceable without
 * adding a failure mode or a prompt-injection surface at the finalization
 * boundary.
 */
import type { CoverageLevel, OverallRecommendation } from '../types/enums.ts';

const coverageWord: Record<CoverageLevel, string> = {
  COVERED: 'Covered',
  PARTIALLY_COVERED: 'Partially covered',
  NOT_COVERED: 'Not covered',
};

export function requirementNotes(input: {
  readonly coverageLevel: CoverageLevel;
  readonly topEvidenceSummaries: readonly string[];
  readonly openGapDescriptions: readonly string[];
  readonly genuineAttempt: boolean;
}): string {
  if (!input.genuineAttempt) return 'Not reached during the interview.';
  const parts: string[] = [`${coverageWord[input.coverageLevel]}.`];
  for (const s of input.topEvidenceSummaries.slice(0, 2)) parts.push(s);
  if (input.openGapDescriptions.length > 0) {
    parts.push(`One outstanding gap: ${input.openGapDescriptions[0]}`);
  }
  return parts.join(' ');
}

export function competencyRationale(input: {
  readonly competencyTag: string;
  readonly coverageLevel: CoverageLevel;
  readonly topEvidenceSummaries: readonly string[];
}): string {
  const lead = `${coverageWord[input.coverageLevel]} for ${input.competencyTag}.`;
  return input.topEvidenceSummaries.length > 0
    ? `${lead} ${input.topEvidenceSummaries.slice(0, 2).join(' ')}`
    : `${lead} No usable evidence was gathered.`;
}

export function recommendationRationale(input: {
  readonly recommendation: OverallRecommendation;
  readonly competencyScore: number | null;
  readonly confidenceBand: string;
  readonly gateStatus: string;
  readonly riskFlags: readonly string[];
}): string {
  if (input.recommendation === 'INSUFFICIENT_DATA') {
    const cause = input.riskFlags[0] ?? 'the interview ended before enough material could be assessed';
    return `Insufficient data to make a recommendation: ${cause}. This is a process outcome, not a judgment on the candidate.`;
  }
  const score = input.competencyScore === null ? 'not computed' : input.competencyScore.toFixed(1);
  const gate =
    input.gateStatus === 'ALL_CLEARED'
      ? 'All configured critical gates cleared.'
      : input.gateStatus === 'ONE_OR_MORE_FAILED'
        ? 'One or more critical gates failed, capping this recommendation.'
        : 'One or more critical gates were never adequately evidenced.';
  return `Competency score ${score}/5 at ${input.confidenceBand} confidence. ${gate} Recommendation: ${input.recommendation.replace(/_/g, ' ').toLowerCase()}.`;
}

export const keyStrength = (label: string, summary: string): string => `${summary} (${label})`;
export const unverifiedNotReached = (label: string): string => `${label} — not reached during the interview`;
export const unverifiedInsufficient = (label: string): string =>
  `${label} — attempted, but evidence remained insufficient`;
export const niceToHaveHighlight = (label: string, summary: string): string =>
  `${summary} (${label}, nice-to-have)`;
