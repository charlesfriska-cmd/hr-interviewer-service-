import { describe, expect, it } from 'vitest';
import { classifyGap, isBlockingGap } from '../../src/domain/gaps/classification.ts';
import { reconcileGapUpdates, type GapUpdate } from '../../src/domain/gaps/reconcile.ts';
import { autoResolveGaps } from '../../src/domain/gaps/autoResolve.ts';
import { asObjectiveId, type EvidenceGap } from '../../src/domain/types/entities.ts';
import { EVIDENCE_GAP_TYPE, type EvidenceGapType } from '../../src/domain/types/enums.ts';

const OBJ = asObjectiveId('obj-uuid-1');

const gap = (gapType: EvidenceGapType, id = `gap_${gapType}`): EvidenceGap => ({
  id,
  interviewId: 'int_1',
  objectiveId: OBJ,
  gapType,
  description: 'missing element',
  status: 'OPEN',
  createdAt: '2026-01-01T10:00:00Z',
  resolvedAt: null,
});

const update = (over: Partial<GapUpdate>): GapUpdate => ({
  objectiveId: OBJ,
  gapType: 'MEASURABLE_OUTCOME',
  description: 'No quantified result stated.',
  status: 'OPEN',
  ...over,
});

describe('gap classification (A5)', () => {
  it('treats CONTRADICTION as blocking', () => {
    expect(classifyGap('CONTRADICTION')).toBe('BLOCKING');
    expect(isBlockingGap('CONTRADICTION')).toBe(true);
  });

  it('treats every missing-element gap type as advisory', () => {
    for (const t of EVIDENCE_GAP_TYPE) {
      if (t === 'CONTRADICTION') continue;
      expect(classifyGap(t)).toBe('ADVISORY');
    }
  });
});

describe('gap reconciliation on (objectiveId, gapType) (C11)', () => {
  it('inserts a gap that has no open row', () => {
    const [i] = reconcileGapUpdates([], [update({})]);
    expect(i).toMatchObject({ kind: 'INSERT', gapType: 'MEASURABLE_OUTCOME', gapClass: 'ADVISORY' });
  });

  it('refreshes the description instead of creating a duplicate row', () => {
    const intents = reconcileGapUpdates(
      [gap('MEASURABLE_OUTCOME')],
      [update({ description: 'still no metric' })],
    );
    expect(intents[0]).toMatchObject({ kind: 'REFRESH_DESCRIPTION', description: 'still no metric' });
  });

  it('resolves a matching open row on an AI-emitted RESOLVED', () => {
    const intents = reconcileGapUpdates(
      [gap('MEASURABLE_OUTCOME')],
      [update({ status: 'RESOLVED' })],
    );
    expect(intents[0]).toMatchObject({ kind: 'RESOLVE', reason: 'AI_RESOLVED' });
  });

  it('treats a RESOLVED with no matching open row as a logged no-op, not an error', () => {
    const intents = reconcileGapUpdates([], [update({ status: 'RESOLVED' })]);
    expect(intents[0]).toMatchObject({ kind: 'NOOP', reason: 'NO_MATCHING_OPEN_GAP' });
  });
});

describe('deterministic auto-resolution (A5)', () => {
  const base = {
    objectiveId: OBJ as string,
    substantiveConditionsMet: true,
    reassertedGapTypes: new Set<EvidenceGapType>(),
    contradictionStatus: 'NONE' as const,
  };

  it('does nothing while the substantive conditions are unmet', () => {
    const r = autoResolveGaps({
      ...base,
      substantiveConditionsMet: false,
      openGaps: [gap('MEASURABLE_OUTCOME')],
    });
    expect(r.resolvedGapIds).toHaveLength(0);
    expect(r.retainedGapIds).toHaveLength(1);
    expect(r.audit).toHaveLength(0);
  });

  it('clears an advisory gap the latest assessment no longer supports', () => {
    const r = autoResolveGaps({ ...base, openGaps: [gap('MEASURABLE_OUTCOME')] });
    expect(r.resolvedGapIds).toEqual(['gap_MEASURABLE_OUTCOME']);
  });

  it('audits every auto-resolution with its basis', () => {
    const r = autoResolveGaps({ ...base, openGaps: [gap('ACTION')] });
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).toMatchObject({
      type: 'GUARDRAIL_OVERRIDE',
      rule: 'GAP_AUTO_RESOLVED',
    });
    expect(r.audit[0]!.payload).toMatchObject({
      gapType: 'ACTION',
      gapClass: 'ADVISORY',
      basis: 'NOT_SUPPORTED_BY_LATEST_ASSESSMENT',
    });
  });

  it('retains a gap the latest turn re-asserted as still open', () => {
    const r = autoResolveGaps({
      ...base,
      openGaps: [gap('ACTION')],
      reassertedGapTypes: new Set<EvidenceGapType>(['ACTION']),
    });
    expect(r.resolvedGapIds).toHaveLength(0);
    expect(r.retainedGapIds).toEqual(['gap_ACTION']);
  });

  it('never auto-resolves a contradiction whose rule is unsatisfied', () => {
    const r = autoResolveGaps({
      ...base,
      openGaps: [gap('CONTRADICTION')],
      contradictionStatus: 'UNRESOLVED',
    });
    expect(r.resolvedGapIds).toHaveLength(0);
    expect(r.retainedGapIds).toEqual(['gap_CONTRADICTION']);
  });

  it('holds a contradiction open even when the turn reports NONE', () => {
    const r = autoResolveGaps({ ...base, openGaps: [gap('CONTRADICTION')] });
    expect(r.resolvedGapIds).toHaveLength(0);
  });

  it('clears a contradiction only once its deterministic rule is satisfied', () => {
    const r = autoResolveGaps({
      ...base,
      openGaps: [gap('CONTRADICTION')],
      contradictionStatus: 'RESOLVED',
    });
    expect(r.resolvedGapIds).toEqual(['gap_CONTRADICTION']);
    expect(r.audit[0]!.payload).toMatchObject({ basis: 'BLOCKING_RULE_SATISFIED' });
  });

  it('an objective never depends on the model emitting a gap-close action', () => {
    // The AI opened a gap and simply moved on without resolving it. The evidence
    // bar is met, so the objective must still be able to complete.
    const r = autoResolveGaps({ ...base, openGaps: [gap('PERSONAL_CONTRIBUTION')] });
    expect(r.retainedGapIds).toHaveLength(0);
  });
});
