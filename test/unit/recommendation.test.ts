import { describe, expect, it } from 'vitest';
import {
  computeOverallRecommendation,
  type RequirementOutcome,
} from '../../src/domain/scoring/recommendation.ts';
import type { JobRequirement, RequirementAssessment } from '../../src/domain/types/entities.ts';

const req = (over: Partial<JobRequirement>): JobRequirement => ({
  id: 'req_1',
  positionId: 'pos_1',
  label: 'Safety awareness',
  description: '',
  priority: 'MUST_HAVE',
  competencyTag: 'safety',
  criticalGate: false,
  ...over,
});

const assess = (over: Partial<RequirementAssessment>): RequirementAssessment => ({
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

const outcome = (over: Partial<RequirementOutcome> = {}): RequirementOutcome => ({
  requirement: req({}),
  assessment: assess({}),
  gateStatus: 'NOT_A_GATE',
  genuineAttempt: true,
  ...over,
});

describe('§8.2 base tier selection (B6)', () => {
  it('requires BOTH the score and the confidence condition of a tier', () => {
    const r = computeOverallRecommendation({
      competencyScore: 4.5, // clears STRONGLY_RECOMMENDED's 4.3
      competencyConfidenceBand: 'MODERATE', // but not its HIGH requirement
      requirementOutcomes: [],
    });
    // Falls through to RECOMMENDED rather than awarding the higher tier.
    expect(r.overallRecommendation).toBe('RECOMMENDED');
  });

  it('awards the top tier when both conditions hold', () => {
    const r = computeOverallRecommendation({
      competencyScore: 4.4,
      competencyConfidenceBand: 'HIGH',
      requirementOutcomes: [],
    });
    expect(r.overallRecommendation).toBe('STRONGLY_RECOMMENDED');
  });

  it('falls to the floor tier when no higher tier is satisfied', () => {
    const r = computeOverallRecommendation({
      competencyScore: 1.0,
      competencyConfidenceBand: 'VERY_LOW',
      requirementOutcomes: [],
    });
    expect(r.overallRecommendation).toBe('NOT_RECOMMENDED');
  });

  it('reproduces the §8.8 worked example', () => {
    const r = computeOverallRecommendation({
      competencyScore: 4.1,
      competencyConfidenceBand: 'HIGH',
      requirementOutcomes: [
        outcome({
          requirement: req({ criticalGate: true, label: 'Incident response' }),
          gateStatus: 'FAILED',
          assessment: assess({ score: 2 }),
        }),
      ],
    });
    expect(r.overallRecommendation).toBe('CONSIDER');
    expect(r.riskFlags).toContain("Critical gate 'Incident response' failed");
  });
});

describe('§8.3 critical-gate INSUFFICIENT_DATA hard override', () => {
  it('overrides outright rather than capping, even with a strong score', () => {
    const r = computeOverallRecommendation({
      competencyScore: 4.9,
      competencyConfidenceBand: 'VERY_HIGH',
      requirementOutcomes: [
        outcome({
          requirement: req({ criticalGate: true, label: 'Licence check' }),
          gateStatus: 'INSUFFICIENT_DATA',
          genuineAttempt: false,
        }),
      ],
    });
    expect(r.overallRecommendation).toBe('INSUFFICIENT_DATA');
    expect(r.riskFlags[0]).toContain('Licence check');
  });

  it('takes precedence over a FAILED gate in the same interview', () => {
    const r = computeOverallRecommendation({
      competencyScore: 4.0,
      competencyConfidenceBand: 'HIGH',
      requirementOutcomes: [
        outcome({ requirement: req({ criticalGate: true, label: 'A' }), gateStatus: 'FAILED' }),
        outcome({
          requirement: req({ id: 'req_2', criticalGate: true, label: 'B' }),
          gateStatus: 'INSUFFICIENT_DATA',
        }),
      ],
    });
    expect(r.overallRecommendation).toBe('INSUFFICIENT_DATA');
  });
});

describe('§8.4 gate capping only ever lowers', () => {
  it('does not raise a tier that is already below the cap', () => {
    const r = computeOverallRecommendation({
      competencyScore: 1.0,
      competencyConfidenceBand: 'VERY_LOW',
      requirementOutcomes: [
        outcome({ requirement: req({ criticalGate: true }), gateStatus: 'FAILED' }),
      ],
    });
    expect(r.overallRecommendation).toBe('NOT_RECOMMENDED');
  });
});

describe('§8.5 material MUST_HAVE non-gate insufficiency', () => {
  it('caps at CONSIDER without triggering the harder override', () => {
    const r = computeOverallRecommendation({
      competencyScore: 4.4,
      competencyConfidenceBand: 'HIGH',
      requirementOutcomes: [
        outcome({
          requirement: req({ priority: 'MUST_HAVE', criticalGate: false, label: 'Scheduling' }),
          assessment: assess({ insufficientEvidenceFlag: true, score: null }),
          genuineAttempt: true,
        }),
      ],
    });
    expect(r.overallRecommendation).toBe('CONSIDER');
    expect(r.concerns[0]).toContain('Scheduling (MUST_HAVE)');
  });

  it('ignores an unevidenced NICE_TO_HAVE entirely (C6)', () => {
    const r = computeOverallRecommendation({
      competencyScore: 4.4,
      competencyConfidenceBand: 'HIGH',
      requirementOutcomes: [
        outcome({
          requirement: req({ priority: 'NICE_TO_HAVE', criticalGate: false }),
          assessment: assess({ insufficientEvidenceFlag: true, score: null }),
          genuineAttempt: false,
        }),
      ],
    });
    expect(r.overallRecommendation).toBe('STRONGLY_RECOMMENDED');
    expect(r.concerns).toHaveLength(0);
  });
});

describe('null competencyScore (AMENDMENTS A2)', () => {
  it('yields INSUFFICIENT_DATA rather than an undefined tier', () => {
    const r = computeOverallRecommendation({
      competencyScore: null,
      competencyConfidenceBand: 'VERY_LOW',
      requirementOutcomes: [],
    });
    expect(r.overallRecommendation).toBe('INSUFFICIENT_DATA');
  });
});
