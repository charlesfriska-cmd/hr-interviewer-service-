import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createHarness,
  createBody,
  SERVICE_KEY,
  type Harness,
} from './harness.ts';
import { requestHash } from '../../src/composition/container.ts';
import {
  initDuplicateRefs,
  initMalformed,
  initNoObjectives,
  initSuccess,
  initUnknownFirstQuestionRef,
  TIMEOUT_STEP,
  TRANSPORT_ERROR_STEP,
} from '../../src/llm/providers/mock/MockHRInterviewerProvider.ts';

/** Requirement ids the deterministic id generator produces for createBody(). */
const REQ_IDS = ['pos-c1_req_1', 'pos-c1_req_2'];

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const post = (harness: Harness, key: string, body: object = createBody()) =>
  request(harness.app).post('/interviews').set('x-service-key', SERVICE_KEY).set('idempotency-key', key).send(body);

describe('POST /interviews — success', () => {
  it('creates the interview, mints canonical ids and returns the first question', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess(REQ_IDS) }] });
    const res = await post(h, 'k1').expect(201);

    expect(res.body.status).toBe('OPENING');
    expect(res.body.question.text).toBe('Tell me about your current role.');

    const objectives = await h.container.plan.objectives(res.body.interviewId);
    expect(objectives).toHaveLength(3);
    // C2: the AI's refs are never the canonical ids.
    for (const o of objectives) expect(String(o.id)).not.toMatch(/^obj_[123]$/);

    const { rows } = await h.pool.query(
      `SELECT ai_ref, id FROM interview_objectives WHERE interview_id = $1 ORDER BY ordinal`,
      [res.body.interviewId],
    );
    expect(rows.map((r) => r.ai_ref)).toEqual(['obj_1', 'obj_2', 'obj_3']);

    // The first question's objective was rewritten to the canonical id.
    const q = await h.container.questions.load(res.body.question.id);
    expect(String(q!.objectiveId)).toBe(rows[0]!.id);
    expect(q!.sequenceNumber).toBe(1);

    // B4: startedAt is set from the first question, not from row creation.
    const interview = await h.container.interviews.load(res.body.interviewId);
    expect(interview!.startedAt).toBeTruthy();
    expect(interview!.status).toBe('OPENING');

    const state = await h.container.state.load(res.body.interviewId);
    expect(state!.lastQuestionId).toBe(res.body.question.id);
    expect(state!.questionsAskedCount).toBe(1);
    expect(state!.version).toBe(0);
  });

  it('never sends criticalGate to the provider (C4 information boundary)', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess(REQ_IDS) }] });
    await post(h, 'k1').expect(201);
    const payload = JSON.stringify(h.provider.calls[0]!.payload);
    expect(payload).not.toContain('criticalGate');
    expect(payload).not.toContain('critical_gate');
  });
});

describe('POST /interviews — request validation', () => {
  it('rejects a payload with no MUST_HAVE requirement before any provider call', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess() }] });
    await post(h, 'k1', createBody({
      requirements: [{ label: 'Nice', priority: 'NICE_TO_HAVE', competencyTag: 'x' }],
    })).expect(400);
    expect(h.provider.calls).toHaveLength(0);
  });

  it('requires an Idempotency-Key', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess() }] });
    await request(h.app).post('/interviews').set('x-service-key', SERVICE_KEY).send(createBody()).expect(400);
  });

  it('rejects an unauthenticated caller', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess() }] });
    await request(h.app).post('/interviews').set('idempotency-key', 'k').send(createBody()).expect(401);
  });
});

describe('POST /interviews — failure behaviour', () => {
  /** Nothing partially usable may exist: no plan, no question, no state. */
  const expectNoUsableInterview = async (harness: Harness) => {
    const { rows: interviews } = await harness.pool.query(`SELECT id, status FROM interviews`);
    expect(interviews).toHaveLength(1);
    expect(interviews[0]!.status).toBe('ERROR');
    const { rows: objectives } = await harness.pool.query(`SELECT 1 FROM interview_objectives`);
    const { rows: questions } = await harness.pool.query(`SELECT 1 FROM questions`);
    const { rows: state } = await harness.pool.query(`SELECT 1 FROM interview_state`);
    expect(objectives).toHaveLength(0);
    expect(questions).toHaveLength(0);
    expect(state).toHaveLength(0);
    // Inputs survive for audit and for a retry that re-enters no data.
    const { rows: reqs } = await harness.pool.query(`SELECT 1 FROM job_requirements`);
    expect(reqs.length).toBeGreaterThan(0);
  };

  it('rejects a malformed InitializationDecision', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initMalformed(REQ_IDS) }] });
    const res = await post(h, 'k1').expect(422);
    expect(res.body.error).toBe('AI_RESPONSE_UNUSABLE');
    await expectNoUsableInterview(h);
  });

  it('rejects duplicate objective refs', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initDuplicateRefs(REQ_IDS) }] });
    const res = await post(h, 'k1').expect(422);
    expect(res.body.error).toBe('DUPLICATE_OBJECTIVE_REF');
    await expectNoUsableInterview(h);
  });

  it('rejects a first question pointing at an unknown objective', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initUnknownFirstQuestionRef(REQ_IDS) }] });
    const res = await post(h, 'k1').expect(422);
    expect(res.body.error).toBe('UNKNOWN_FIRST_QUESTION_REF');
    await expectNoUsableInterview(h);
  });

  it('rejects a plan with no objectives at the schema boundary', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initNoObjectives(REQ_IDS) }] });
    const res = await post(h, 'k1').expect(422);
    // Ajv's minItems catches this before the rules engine sees it; the
    // NO_OBJECTIVES rule remains as defence in depth and is unit-tested directly.
    expect(res.body.error).toBe('AI_RESPONSE_UNUSABLE');
    await expectNoUsableInterview(h);
  });

  it('surfaces a provider timeout after the adapter exhausts its retries', async () => {
    h = await createHarness({ steps: [TIMEOUT_STEP] });
    const res = await post(h, 'k1').expect(422);
    expect(res.body.error).toBe('AI_RESPONSE_UNUSABLE');
    await expectNoUsableInterview(h);
  });

  it('retries a transient transport error and succeeds', async () => {
    h = await createHarness({
      steps: [TRANSPORT_ERROR_STEP, { kind: 'respond', payload: initSuccess(REQ_IDS) }],
    });
    await post(h, 'k1').expect(201);
  });

  it('caps retries at three attempts, then returns the cached failure permanently', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initMalformed(REQ_IDS) }] });
    await post(h, 'k1').expect(422);
    await post(h, 'k1').expect(422);
    await post(h, 'k1').expect(422);
    // 4th replay is terminal and must not re-invoke the provider.
    const callsBefore = h.provider.calls.length;
    const res = await post(h, 'k1').expect(422);
    expect(res.body.error).toBe('INITIALIZATION_FAILED');
    expect(h.provider.calls.length).toBe(callsBefore);
    const { rows } = await h.pool.query(`SELECT status, attempt_count FROM turn_operations`);
    expect(rows[0]!.status).toBe('FAILED_FINAL');
  });

  it('resumes a failed attempt without re-entering candidate data', async () => {
    h = await createHarness({
      steps: [
        { kind: 'respond', payload: initMalformed(REQ_IDS) },
        { kind: 'respond', payload: initSuccess(REQ_IDS) },
      ],
    });
    await post(h, 'k1').expect(422);
    const res = await post(h, 'k1').expect(201);
    // Same interview, reusing the already-persisted rows.
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM interviews`);
    expect(rows[0]!.n).toBe(1);
    const { rows: cands } = await h.pool.query(`SELECT count(*)::int AS n FROM candidates`);
    expect(cands[0]!.n).toBe(1);
    expect(res.body.status).toBe('OPENING');
  });
});

describe('POST /interviews — idempotency', () => {
  it('replays a successful create without a second provider call', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess(REQ_IDS) }] });
    const first = await post(h, 'k1').expect(201);
    const callsAfterFirst = h.provider.calls.length;
    const second = await post(h, 'k1').expect(201);
    expect(second.body.interviewId).toBe(first.body.interviewId);
    expect(second.body.question.id).toBe(first.body.question.id);
    expect(h.provider.calls.length).toBe(callsAfterFirst);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM interviews`);
    expect(rows[0]!.n).toBe(1);
  });

  it('rejects the same key with a different body rather than serving the wrong result', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess(REQ_IDS) }] });
    await post(h, 'k1').expect(201);
    const res = await post(h, 'k1', createBody({ position: { title: 'Different', jobDescription: 'Other' } }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INITIALIZATION_FAILED');
  });

  it('reclaims an expired PROCESSING lease instead of wedging at 409 (B3)', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess(REQ_IDS) }] });
    // Simulate a crashed attempt: a PROCESSING row whose lease expired before the
    // clock the service reads. Timestamps come from the test clock, not Postgres
    // now(), so the comparison the store makes is the one under test.
    const base = h.clock.current.getTime();
    await h.pool.query(
      `INSERT INTO turn_operations (id, scope, idempotency_key, request_hash, status,
         attempt_count, processing_started_at, processing_lease_expires_at, expires_at)
       VALUES ('op_interview_create_k1','interview_create','k1',$1,'PROCESSING',1,$2,$3,$4)`,
      [
        requestHash(createBody()),
        new Date(base - 3_600_000).toISOString(),
        new Date(base - 1_800_000).toISOString(),
        new Date(base + 86_400_000).toISOString(),
      ],
    );
    const res = await post(h, 'k1');
    expect(res.status).toBe(201);
    const { rows } = await h.pool.query(`SELECT attempt_count, status FROM turn_operations`);
    expect(rows[0]!.attempt_count).toBe(2);
    expect(rows[0]!.status).toBe('SUCCEEDED');
  });

  it('returns 409 while a lease is still valid', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess(REQ_IDS) }] });
    const base = h.clock.current.getTime();
    await h.pool.query(
      `INSERT INTO turn_operations (id, scope, idempotency_key, request_hash, status,
         attempt_count, processing_started_at, processing_lease_expires_at, expires_at)
       VALUES ('op_interview_create_k1','interview_create','k1',$1,'PROCESSING',1,$2,$3,$4)`,
      [
        requestHash(createBody()),
        new Date(base).toISOString(),
        new Date(base + 600_000).toISOString(),
        new Date(base + 86_400_000).toISOString(),
      ],
    );
    await post(h, 'k1').expect(409);
  });
});
