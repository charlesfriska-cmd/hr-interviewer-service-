import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MESSAGE,
  TurnPipeline,
  type TurnPipelineDeps,
} from '../../src/application/pipelines/TurnPipeline.ts';
import {
  denylistSafety,
  FakeClock,
  FakeLLM,
  FakeOperations,
  FakeUow,
  FakeWorld,
  passthroughSafety,
  SeqIds,
} from '../fakes/inMemory.ts';
import type { SafetyScanner } from '../../src/application/ports/ports.ts';

const decision = (over: Record<string, unknown> = {}) => ({
  status: 'in_progress',
  recommended_action: 'FOLLOW_UP',
  candidate_message: 'Thanks — what was your role specifically?',
  question: {
    phase: 'COMPETENCY_DEEP_DIVE',
    objective: 'obj_1',
    competency: 'system_design',
    question_type: 'behavioral_follow_up',
    text: 'What was your role specifically?',
  },
  evidence_updates: [
    {
      requirement_id: 'req_1',
      competency: 'system_design',
      summary: 'Led the migration.',
      strength: 'STRONG',
    },
  ],
  assessment_updates: [
    {
      requirement_id: 'req_1',
      competency: 'system_design',
      coverage_level: 'COVERED',
      confidence_band: 'HIGH',
    },
  ],
  evidence_gap_updates: [],
  operational_reasoning: { objective: 'Establish ownership', evidence_gap: 'none' },
  contradiction_status: 'NONE',
  progress: { objectives_completed: 1, objectives_total: 3 },
  ...over,
});

function build(
  world: FakeWorld,
  llmResult: Parameters<typeof FakeLLM.prototype.runTurn> extends never ? never : ConstructorParameters<typeof FakeLLM>[0],
  safety: SafetyScanner = passthroughSafety,
) {
  const ops = new FakeOperations();
  const uow = new FakeUow();
  const llm = new FakeLLM(llmResult);
  const deps: TurnPipelineDeps = {
    clock: new FakeClock(new Date('2026-01-01T09:12:00Z')),
    ids: new SeqIds(),
    uow,
    operations: ops,
    interviews: world.interviews,
    state: world.stateRepo,
    plan: world.plan,
    questions: world.questionRepo,
    responses: world.responseRepo,
    evidence: world.evidenceRepo,
    gaps: world.gapRepo,
    assessments: world.assessmentRepo,
    audit: world.auditWriter,
    llm,
    safety,
  };
  return { pipeline: new TurnPipeline(deps), ops, uow, llm };
}

const cmd = {
  interviewId: 'int_1',
  questionId: 'q_existing',
  answer: 'I owned the architecture decision.',
  idempotencyKey: 'key_1',
  requestHash: 'hash_1',
};

describe('cheap deterministic rejections happen before any LLM spend', () => {
  it('rejects a stale questionId with 409 and never calls the provider', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    w.state.lastQuestionId = 'q_other';
    const { pipeline, llm } = build(w, { kind: 'ok', decision: decision() });
    const r = await pipeline.submit(cmd);
    expect(r).toMatchObject({ kind: 'error', status: 409, code: 'STALE_QUESTION' });
    expect(llm.calls).toBe(0);
  });

  it('rejects a terminal interview with 409', async () => {
    const w = new FakeWorld({ interview: { status: 'COMPLETED' } });
    w.objective();
    w.question();
    const { pipeline, llm } = build(w, { kind: 'ok', decision: decision() });
    const r = await pipeline.submit(cmd);
    expect(r).toMatchObject({ status: 409, code: 'INTERVIEW_TERMINAL' });
    expect(llm.calls).toBe(0);
  });
});

describe('happy path', () => {
  it('persists the answer, evidence and next question, and advances state', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const { pipeline, ops } = build(w, { kind: 'ok', decision: decision() });

    const r = await pipeline.submit(cmd);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    expect(r.body.status).toBe('in_progress');
    expect(r.body.question?.text).toBe('What was your role specifically?');
    expect(w.responses).toHaveLength(1);
    expect(w.evidence).toHaveLength(1);
    // sourceResponseId is taken from this turn, never trusted from AI output.
    expect(w.evidence[0]!.sourceResponseId).toBe(w.responses[0]!.id);
    expect(w.state.questionsAskedCount).toBe(4);
    expect(w.state.version).toBe(8);
    expect(ops.succeeded).toHaveLength(1);
  });

  it('accrues clamped active time, not wall clock (B4)', async () => {
    const w = new FakeWorld();
    w.objective();
    // Presented 09:08, clock now 09:12 => 240s genuine, under the 600s clamp.
    w.question();
    const { pipeline } = build(w, { kind: 'ok', decision: decision() });
    await pipeline.submit(cmd);
    expect(w.state.elapsedActiveInterviewSeconds).toBe(300 + 240);
    expect(w.state.phaseElapsedSeconds.COMPETENCY_DEEP_DIVE).toBe(240);
  });

  it('never exposes a scoring signal on the candidate-facing surface', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const { pipeline } = build(w, { kind: 'ok', decision: decision() });
    const r = await pipeline.submit(cmd);
    if (r.kind !== 'ok') throw new Error('expected ok');
    const json = JSON.stringify(r.body);
    for (const forbidden of ['strength', 'coverage_level', 'confidence_band', 'operational_reasoning', 'contradiction_status', 'evidence']) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe('guardrails', () => {
  it('forces completion at the question cap, from whatever phase is current (C9)', async () => {
    const w = new FakeWorld({ state: { questionsAskedCount: 24 } });
    w.objective({ status: 'SATISFIED' });
    w.question();
    const { pipeline } = build(w, { kind: 'ok', decision: decision() });
    const r = await pipeline.submit(cmd);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.body.status).toBe('complete');
    expect(r.body.question).toBeUndefined();
    expect(w.auditRules()).toContain('MAX_QUESTIONS_REACHED');
  });

  it('forces completion when active time is exhausted', async () => {
    const w = new FakeWorld({ state: { elapsedActiveInterviewSeconds: 50 * 60 } });
    w.objective({ status: 'SATISFIED' });
    w.question();
    const { pipeline } = build(w, { kind: 'ok', decision: decision() });
    const r = await pipeline.submit(cmd);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.body.status).toBe('complete');
    expect(w.auditRules()).toContain('TIME_EXHAUSTED');
  });

  it('records exactly one override when two rules could fire', async () => {
    const w = new FakeWorld({
      state: { questionsAskedCount: 24, followUpsByObjective: { obj_1: 2 } },
    });
    w.objective({ status: 'SATISFIED' });
    w.question();
    const { pipeline } = build(w, { kind: 'ok', decision: decision() });
    await pipeline.submit(cmd);
    const overrides = w.audits.filter((a) => a.type === 'GUARDRAIL_OVERRIDE');
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.rule).toBe('MAX_QUESTIONS_REACHED');
  });

  it('blocks premature completion while a MUST_HAVE objective is open', async () => {
    const w = new FakeWorld();
    w.objective({ status: 'IN_PROGRESS' });
    w.question();
    const { pipeline } = build(w, {
      kind: 'ok',
      decision: decision({ recommended_action: 'COMPLETE_INTERVIEW' }),
    });
    const r = await pipeline.submit(cmd);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.body.status).toBe('in_progress');
    expect(w.auditRules()).toContain('PREMATURE_COMPLETION_BLOCKED');
  });

  it('routes an unknown competency reference to the retry path, not an override', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const bad = decision();
    (bad.question as Record<string, unknown>).competency = 'hallucinated_tag';
    const { pipeline, ops } = build(w, { kind: 'ok', decision: bad });
    const r = await pipeline.submit(cmd);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.body.message).toBe(FALLBACK_MESSAGE);
    expect(w.auditRules()).toContain('UNKNOWN_REFERENCE');
    expect(ops.failed[0]).toMatchObject({ retryable: true });
  });
});

describe('fail-soft and concurrency', () => {
  it('returns 200 with the hold message and leaves state unadvanced (C10)', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const before = w.state.version;
    const { pipeline, ops } = build(w, { kind: 'failed', errors: ['bad json'] });

    const r = await pipeline.submit(cmd);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.status).toBe(200);
    expect(r.body.message).toBe(FALLBACK_MESSAGE);
    expect(w.state.version).toBe(before);
    // The answer survives, so the retry is a resume rather than a lost turn.
    expect(w.responses).toHaveLength(1);
    // Nothing is cached as a success — that is what stops the permanent wedge.
    expect(ops.succeeded).toHaveLength(0);
    expect(ops.failed[0]).toMatchObject({ retryable: true });
  });

  it('does not insert a second answer row when resuming', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    w.responses.push({
      id: 'resp_existing',
      questionId: 'q_existing',
      interviewId: 'int_1',
      answerText: 'I owned the architecture decision.',
      receivedAt: '2026-01-01T09:10:00Z',
    });
    const { pipeline } = build(w, { kind: 'ok', decision: decision() });
    await pipeline.submit(cmd);
    expect(w.responses).toHaveLength(1);
  });

  it('returns 409 on a state version conflict rather than overwriting', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    w.casShouldFail = true;
    const { pipeline, ops } = build(w, { kind: 'ok', decision: decision() });
    const r = await pipeline.submit(cmd);
    expect(r).toMatchObject({ status: 409, code: 'STATE_VERSION_CONFLICT' });
    expect(ops.failed[0]).toMatchObject({ retryable: true });
  });

  it('replays a SUCCEEDED operation without calling the provider', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const { pipeline, ops, llm } = build(w, { kind: 'ok', decision: decision() });
    ops.setNext({ kind: 'replay', status: 200, body: { status: 'in_progress', message: 'cached' } });
    const r = await pipeline.submit(cmd);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.body.message).toBe('cached');
    expect(llm.calls).toBe(0);
  });

  it('returns 409 for a genuinely concurrent duplicate', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const { pipeline, ops } = build(w, { kind: 'ok', decision: decision() });
    ops.setNext({ kind: 'conflict' });
    const r = await pipeline.submit(cmd);
    expect(r).toMatchObject({ status: 409, code: 'OPERATION_IN_FLIGHT' });
  });
});

describe('evidence gaps (A5)', () => {
  const withGapUpdate = (gapType: string, status = 'OPEN') =>
    decision({
      evidence_gap_updates: [
        { objective_ref: 'obj_1', gap_type: gapType, description: 'no metric given', status },
      ],
    });

  it('opens a gap the AI reports', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    w.coverage = 'PARTIALLY_COVERED';
    const { pipeline } = build(w, { kind: 'ok', decision: withGapUpdate('MEASURABLE_OUTCOME') });
    await pipeline.submit(cmd);
    expect(w.openGapTypes()).toContain('MEASURABLE_OUTCOME');
  });

  it('auto-resolves a stale advisory gap once the evidence bar is met, and audits it', async () => {
    const w = new FakeWorld();
    w.objective({ targetEvidenceCount: 1 });
    w.question();
    // The AI opened this gap on an earlier turn and simply moved on.
    w.gap('MEASURABLE_OUTCOME');
    w.coverage = 'COVERED';
    const { pipeline } = build(w, { kind: 'ok', decision: decision() });

    await pipeline.submit(cmd);
    expect(w.openGapTypes()).toHaveLength(0);
    expect(w.auditRules()).toContain('GAP_AUTO_RESOLVED');
    // The objective completes rather than being recorded a failure.
    expect(w.objectives[0]!.status).toBe('SATISFIED');
  });

  it('retains an advisory gap the AI re-asserts, without letting it block completion', async () => {
    const w = new FakeWorld();
    w.objective({ targetEvidenceCount: 1 });
    w.question();
    w.gap('MEASURABLE_OUTCOME');
    w.coverage = 'COVERED';
    const { pipeline } = build(w, { kind: 'ok', decision: withGapUpdate('MEASURABLE_OUTCOME') });
    await pipeline.submit(cmd);
    // Still supported by the latest assessment, so it is not auto-resolved...
    expect(w.openGapTypes()).toContain('MEASURABLE_OUTCOME');
    expect(w.auditRules()).not.toContain('GAP_AUTO_RESOLVED');
    // ...but an advisory gap is not a blocker: the evidence bar decides (A5 condition 4).
    expect(w.objectives[0]!.status).toBe('SATISFIED');
  });

  it('never auto-resolves an unresolved contradiction, and it blocks SATISFIED', async () => {
    const w = new FakeWorld();
    w.objective({ targetEvidenceCount: 1 });
    w.question();
    w.gap('CONTRADICTION');
    w.coverage = 'COVERED';
    const { pipeline } = build(w, {
      kind: 'ok',
      decision: decision({ contradiction_status: 'UNRESOLVED' }),
    });
    await pipeline.submit(cmd);
    expect(w.openGapTypes()).toContain('CONTRADICTION');
    expect(w.objectives[0]!.status).toBe('IN_PROGRESS');
  });

  it('clears a contradiction once the turn reports it resolved', async () => {
    const w = new FakeWorld();
    w.objective({ targetEvidenceCount: 1 });
    w.question();
    w.gap('CONTRADICTION');
    w.coverage = 'COVERED';
    const { pipeline } = build(w, {
      kind: 'ok',
      decision: decision({ contradiction_status: 'RESOLVED' }),
    });
    await pipeline.submit(cmd);
    expect(w.openGapTypes()).toHaveLength(0);
    expect(w.objectives[0]!.status).toBe('SATISFIED');
  });

  it('drops a gap update naming an unknown objective without failing the turn', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const bad = decision({
      evidence_gap_updates: [
        { objective_ref: 'obj_unknown', gap_type: 'ACTION', description: 'x', status: 'OPEN' },
      ],
    });
    const { pipeline } = build(w, { kind: 'ok', decision: bad });
    const r = await pipeline.submit(cmd);
    expect(r.kind).toBe('ok');
    expect(w.auditRules()).toContain('INVALID_GAP_UPDATE_DROPPED');
  });
});

describe('safety backstop', () => {
  it('substitutes the whole candidate message rather than garbling it', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const { pipeline } = build(
      w,
      { kind: 'ok', decision: decision({ candidate_message: 'Given your maternity leave, ...' }) },
      denylistSafety('maternity'),
    );
    const r = await pipeline.submit(cmd);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.body.message).toBe(FALLBACK_MESSAGE);
    expect(r.body.message).not.toContain('[redacted]');
    expect(w.auditRules()).toContain('PROTECTED_CHARACTERISTIC_FILTERED');
  });

  it('redacts in place inside a stored evidence summary', async () => {
    const w = new FakeWorld();
    w.objective();
    w.question();
    const dec = decision({
      evidence_updates: [
        {
          requirement_id: 'req_1',
          competency: 'system_design',
          summary: 'Returned from maternity leave and led the migration.',
          strength: 'STRONG',
        },
      ],
    });
    const { pipeline } = build(w, { kind: 'ok', decision: dec }, denylistSafety('maternity'));
    await pipeline.submit(cmd);
    expect(w.evidence[0]!.summary).toContain('[redacted]');
  });
});
