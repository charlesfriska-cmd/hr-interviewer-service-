import { describe, expect, it } from 'vitest';
import { bandAtLeast, bandIndex, lowerBand } from '../../src/domain/scoring/confidence.ts';
import { computeScore, highestUsableStrength } from '../../src/domain/scoring/scoreTable.ts';
import { deriveRating } from '../../src/domain/scoring/rating.ts';
import {
  computeCompetencyScore,
  resolveCompetencyWeight,
} from '../../src/domain/scoring/competencyTrack.ts';
import {
  aggregateCriticalGateStatus,
  evaluateGateStatus,
} from '../../src/domain/scoring/gates.ts';
import type { CompetencyAssessment, JobRequirement, RequirementAssessment } from '../../src/domain/types/entities.ts';

const competency = (over: Partial<CompetencyAssessment>): CompetencyAssessment => ({
  competencyTag: 'communication',
  interviewId: 'int_1',
  coverageLevel: 'COVERED',
  rating: 'ADEQUATE',
  score: 3,
  confidenceBand: 'HIGH',
  confidenceScore: 0.775,
  evidenceIds: [],
  gapIds: [],
  weight: 1.0,
  rationale: '',
  ...over,
});

describe('confidence band total order (B6, SCORING v3 §4)', () => {
  it('orders bands lowest to highest', () => {
    expect(bandIndex('VERY_LOW')).toBe(0);
    expect(bandIndex('VERY_HIGH')).toBe(4);
  });

  it('compares by index, not string equality', () => {
    expect(bandAtLeast('VERY_HIGH', 'HIGH')).toBe(true);
    expect(bandAtLeast('HIGH', 'HIGH')).toBe(true);
    expect(bandAtLeast('MODERATE', 'HIGH')).toBe(false);
  });

  it('takes the weaker of two bands', () => {
    expect(lowerBand('VERY_HIGH', 'LOW')).toBe('LOW');
  });
});

describe('evidence score table (INTERVIEW_STATE v3 §8.1)', () => {
  it('scores from the highest usable strength and coverage', () => {
    expect(computeScore(['MODERATE', 'VERY_STRONG'], 'COVERED').score).toBe(5);
    expect(computeScore(['WEAK'], 'NOT_COVERED').score).toBe(1);
  });

  it('ignores INSUFFICIENT when ranking strength', () => {
    expect(highestUsableStrength(['INSUFFICIENT', 'WEAK'])).toBe('WEAK');
  });

  it('never lowers a score for absent evidence — it yields null and a flag', () => {
    expect(computeScore([], 'COVERED')).toEqual({ score: null, insufficientEvidenceFlag: true });
    expect(computeScore(['INSUFFICIENT'], 'COVERED')).toEqual({
      score: null,
      insufficientEvidenceFlag: true,
    });
  });
});

describe('rating derivation (C7)', () => {
  it('uses range thresholds, not exact equality', () => {
    expect(deriveRating(4.0)).toBe('STRONG');
    expect(deriveRating(4.7)).toBe('STRONG');
    expect(deriveRating(3.2)).toBe('ADEQUATE');
    expect(deriveRating(2.9)).toBe('WEAK');
  });

  it('maps a null score to INSUFFICIENT_EVIDENCE regardless of thresholds', () => {
    expect(deriveRating(null)).toBe('INSUFFICIENT_EVIDENCE');
  });
});

describe('competency weight sourcing (B1)', () => {
  it('always weights position-specific competencies 1.0 in MVP', () => {
    expect(resolveCompetencyWeight('incident_response', 'POSITION_SPECIFIC')).toBe(1.0);
  });

  it('falls back to the default weight for unlisted universal tags', () => {
    expect(resolveCompetencyWeight('communication', 'UNIVERSAL')).toBe(1.0);
  });
});

describe('competency score track (SCORING v3 §5.1)', () => {
  it('computes a weighted mean over scored rows', () => {
    const r = computeCompetencyScore([
      competency({ score: 4, weight: 1 }),
      competency({ competencyTag: 'ownership', score: 2, weight: 1 }),
    ]);
    expect(r.competencyScore).toBe(3);
  });

  it('excludes null-score rows from numerator AND denominator', () => {
    const r = computeCompetencyScore([
      competency({ score: 4, weight: 1 }),
      competency({ competencyTag: 'x', score: null, weight: 1 }),
    ]);
    expect(r.competencyScore).toBe(4);
  });

  it('returns a null score when nothing reached adequate evidence', () => {
    const r = computeCompetencyScore([competency({ score: null })]);
    expect(r.competencyScore).toBeNull();
  });

  it('reports the weakest contributing confidence band', () => {
    const r = computeCompetencyScore([
      competency({ score: 4, confidenceBand: 'VERY_HIGH' }),
      competency({ competencyTag: 'y', score: 4, confidenceBand: 'LOW' }),
    ]);
    expect(r.competencyConfidenceBand).toBe('LOW');
  });
});

const requirement = (over: Partial<JobRequirement>): JobRequirement => ({
  id: 'req_1',
  positionId: 'pos_1',
  label: 'Incident response',
  description: '',
  priority: 'MUST_HAVE',
  competencyTag: 'incident_response',
  criticalGate: false,
  ...over,
});

const assessment = (over: Partial<RequirementAssessment>): RequirementAssessment => ({
  requirementId: 'req_1',
  interviewId: 'int_1',
  coverageLevel: 'COVERED',
  score: 4,
  confidenceBand: 'HIGH',
  confidenceScore: 0.775,
  evidenceIds: [],
  gapIds: [],
  insufficientEvidenceFlag: false,
  gateStatus: 'NOT_A_GATE',
  notes: '',
  ...over,
});

describe('critical gates (B1, B2, SCORING v3 §6)', () => {
  it('marks non-gate requirements NOT_A_GATE regardless of score', () => {
    expect(
      evaluateGateStatus({
        requirement: requirement({ criticalGate: false }),
        assessment: assessment({ score: 1 }),
        genuineAttempt: true,
      }),
    ).toBe('NOT_A_GATE');
  });

  it('clears a gate at or above gateClearanceMinScore', () => {
    expect(
      evaluateGateStatus({
        requirement: requirement({ criticalGate: true }),
        assessment: assessment({ score: 3 }),
        genuineAttempt: true,
      }),
    ).toBe('CLEARED');
  });

  it('fails a gate with adequate evidence below the minimum', () => {
    expect(
      evaluateGateStatus({
        requirement: requirement({ criticalGate: true }),
        assessment: assessment({ score: 2 }),
        genuineAttempt: true,
      }),
    ).toBe('FAILED');
  });

  it('distinguishes an untested gate from a failed one', () => {
    expect(
      evaluateGateStatus({
        requirement: requirement({ criticalGate: true }),
        assessment: assessment({ score: null, insufficientEvidenceFlag: true }),
        genuineAttempt: false,
      }),
    ).toBe('INSUFFICIENT_DATA');
  });

  it('ranks INSUFFICIENT above FAILED when summarising', () => {
    expect(aggregateCriticalGateStatus(['CLEARED', 'FAILED', 'INSUFFICIENT_DATA'])).toBe(
      'ONE_OR_MORE_INSUFFICIENT',
    );
    expect(aggregateCriticalGateStatus(['CLEARED', 'FAILED'])).toBe('ONE_OR_MORE_FAILED');
    expect(aggregateCriticalGateStatus(['CLEARED', 'NOT_A_GATE'])).toBe('ALL_CLEARED');
  });
});
