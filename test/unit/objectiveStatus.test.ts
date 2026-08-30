import { describe, expect, it } from 'vitest';
import {
  afterAppliedTurn,
  genuineAttempt,
  meetsSatisfiedCriteria,
  onObjectiveClosed,
  onQuestionPresented,
} from '../../src/domain/state/objectiveStatus.ts';
import {
  asObjectiveId,
  type EvidenceGap,
  type InterviewObjective,
} from '../../src/domain/types/entities.ts';
import type { EvidenceGapType } from '../../src/domain/types/enums.ts';
import type { ObjectiveEvaluationInput } from '../../src/domain/state/objectiveStatus.ts';

const objective = (over: Partial<InterviewObjective> = {}): InterviewObjective => ({
  id: asObjectiveId('obj-uuid-1'),
  phase: 'COMPETENCY_DEEP_DIVE',
  requirementIds: ['req_1'],
  competencyTag: 'system_design',
  competencyLayer: 'POSITION_SPECIFIC',
  targetEvidenceCount: 2,
  status: 'IN_PROGRESS',
  ...over,
});

const gap = (gapType: EvidenceGapType, id = `gap_${gapType}`): EvidenceGap => ({
  id,
  interviewId: 'int_1',
  objectiveId: asObjectiveId('obj-uuid-1'),
  gapType,
  description: 'missing element',
  status: 'OPEN',
  createdAt: '2026-01-01T10:00:00Z',
  resolvedAt: null,
});

const input = (over: Partial<ObjectiveEvaluationInput> = {}): ObjectiveEvaluationInput => ({
  objective: objective(),
  coverageLevel: 'COVERED',
  evidenceStrengths: ['STRONG', 'MODERATE'],
  openGaps: [],
  questionCount: 2,
  ...over,
});

describe('SATISFIED requires all four conditions (B5, §5a)', () => {
  it('satisfies when coverage, usable evidence, target and gaps all pass', () => {
    expect(meetsSatisfiedCriteria(input())).toBe(true);
  });

  it('rejects PARTIALLY_COVERED alone', () => {
    expect(meetsSatisfiedCriteria(input({ coverageLevel: 'PARTIALLY_COVERED' }))).toBe(false);
  });

  it('rejects evidence that is entirely INSUFFICIENT', () => {
    expect(
      meetsSatisfiedCriteria(input({ evidenceStrengths: ['INSUFFICIENT', 'INSUFFICIENT'] })),
    ).toBe(false);
  });

  it('rejects an unmet targetEvidenceCount even with strong evidence', () => {
    expect(meetsSatisfiedCriteria(input({ evidenceStrengths: ['VERY_STRONG'] }))).toBe(false);
  });

  it('rejects while a BLOCKING gap is still open (A5 condition 4)', () => {
    expect(meetsSatisfiedCriteria(input({ openGaps: [gap('CONTRADICTION')] }))).toBe(false);
  });

  it('satisfies despite an open ADVISORY gap the evidence already covers (A5)', () => {
    expect(meetsSatisfiedCriteria(input({ openGaps: [gap('MEASURABLE_OUTCOME')] }))).toBe(true);
  });

  it('satisfies on coverage and usable evidence alone when no target is configured', () => {
    expect(
      meetsSatisfiedCriteria(
        input({
          objective: objective({ targetEvidenceCount: 0 }),
          evidenceStrengths: ['STRONG'],
        }),
      ),
    ).toBe(true);
  });
});

describe('lifecycle transitions', () => {
  it('moves PENDING to IN_PROGRESS when the first question is presented', () => {
    expect(onQuestionPresented('PENDING')).toBe('IN_PROGRESS');
    expect(onQuestionPresented('SATISFIED')).toBe('SATISFIED');
  });

  it('holds IN_PROGRESS after a turn that does not meet the bar', () => {
    expect(afterAppliedTurn(input({ openGaps: [gap('CONTRADICTION')] }))).toBe('IN_PROGRESS');
  });

  it('reaches SATISFIED after a qualifying turn', () => {
    expect(afterAppliedTurn(input())).toBe('SATISFIED');
  });

  it('closes an attempted-but-unresolved objective as INSUFFICIENT_EVIDENCE', () => {
    expect(onObjectiveClosed(input({ coverageLevel: 'PARTIALLY_COVERED' }))).toBe(
      'INSUFFICIENT_EVIDENCE',
    );
  });

  it('leaves a never-reached objective PENDING, distinct from an attempted one', () => {
    expect(
      onObjectiveClosed(
        input({ objective: objective({ status: 'PENDING' }), questionCount: 0 }),
      ),
    ).toBe('PENDING');
  });

  it('treats terminal states as terminal', () => {
    expect(onObjectiveClosed(input({ objective: objective({ status: 'SATISFIED' }) }))).toBe(
      'SATISFIED',
    );
  });
});

describe('genuineAttempt (B5 canonical definition)', () => {
  it('requires both a non-PENDING status and at least one question', () => {
    expect(genuineAttempt(objective({ status: 'IN_PROGRESS' }), 1)).toBe(true);
    expect(genuineAttempt(objective({ status: 'IN_PROGRESS' }), 0)).toBe(false);
    expect(genuineAttempt(objective({ status: 'PENDING' }), 0)).toBe(false);
  });
});
