import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness, createBody, SERVICE_KEY, type Harness } from './harness.ts';
import { initSuccess, type MockStep } from '../../src/llm/providers/mock/MockHRInterviewerProvider.ts';

const REQ_IDS = ['pos-c1_req_1', 'pos-c1_req_2'];
/** Canonical objective ids the deterministic generator mints, in plan order. */
const OBJ = { opening: 'obj-c1', design: 'obj-c2', motivation: 'obj-c3' };

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const turn = (over: Record<string, unknown>): MockStep => ({
  kind: 'respond',
  payload: {
    status: 'in_progress',
    recommended_action: 'FOLLOW_UP',
    candidate_message: 'Thanks — tell me more.',
    question: {
      phase: 'COMPETENCY_DEEP_DIVE',
      objective: OBJ.design,
      competency: 'system_design',
      question_type: 'behavioral_follow_up',
      text: 'What was your specific role?',
    },
    evidence_updates: [],
    assessment_updates: [],
    evidence_gap_updates: [],
    operational_reasoning: { objective: 'probe', evidence_gap: 'unclear' },
    contradiction_status: 'NONE',
    progress: { objectives_completed: 0, objectives_total: 3 },
    ...over,
  },
});

const evidence = (competency: string, strength: string, summary: string, requirementId: string | null) => ({
  requirement_id: requirementId, competency, summary, strength,
});
const assessment = (competency: string, coverage: string, band: string, requirementId: string | null) => ({
  requirement_id: requirementId, competency, coverage_level: coverage, confidence_band: band,
});

describe('end-to-end mock interview', () => {
  it('runs a full interview and produces a traceable final assessment', async () => {
    h = await createHarness({
      steps: [
        // 1. initialization
        { kind: 'respond', payload: initSuccess(REQ_IDS) },

        // Turn 1 — opening answer. Weak evidence, opens an ADVISORY gap.
        turn({
          question: {
            phase: 'COMPETENCY_DEEP_DIVE', objective: OBJ.design, competency: 'system_design',
            question_type: 'behavioral', text: 'Tell me about a migration you led.',
          },
          evidence_updates: [evidence('communication', 'MODERATE', 'Explained role clearly and concisely.', null)],
          assessment_updates: [assessment('communication', 'COVERED', 'HIGH', null)],
        }),

        // Turn 2 — team-level answer only. Advisory gap opened on the design objective.
        turn({
          evidence_updates: [evidence('system_design', 'WEAK', 'Team migrated a service.', REQ_IDS[0]!)],
          assessment_updates: [assessment('system_design', 'PARTIALLY_COVERED', 'LOW', REQ_IDS[0]!)],
          evidence_gap_updates: [{
            objective_ref: OBJ.design, gap_type: 'PERSONAL_CONTRIBUTION',
            description: 'Individual ownership not established.', status: 'OPEN',
          }],
        }),

        // Turn 3 — ownership established; the AI explicitly resolves that gap.
        turn({
          evidence_updates: [evidence('system_design', 'STRONG', 'Owned the architecture decision; unblocked two teams.', REQ_IDS[0]!)],
          assessment_updates: [assessment('system_design', 'COVERED', 'HIGH', REQ_IDS[0]!)],
          evidence_gap_updates: [{
            objective_ref: OBJ.design, gap_type: 'PERSONAL_CONTRIBUTION',
            description: 'Ownership now established.', status: 'RESOLVED',
          }],
        }),

        // Turn 4 — MOVE_NEXT to motivation; leaves an ADVISORY gap open that the
        // AI never closes. A5's auto-resolution must stop that inverting the outcome.
        turn({
          recommended_action: 'MOVE_NEXT',
          question: {
            phase: 'MOTIVATION_FIT', objective: OBJ.motivation, competency: 'motivation',
            question_type: 'motivation', text: 'What draws you to this role?',
          },
          evidence_updates: [evidence('system_design', 'VERY_STRONG', 'Cut p95 latency by 30%.', REQ_IDS[0]!)],
          assessment_updates: [assessment('system_design', 'COVERED', 'VERY_HIGH', REQ_IDS[0]!)],
          evidence_gap_updates: [{
            objective_ref: OBJ.design, gap_type: 'TECHNICAL_DEPTH',
            description: 'Trade-off reasoning not fully explored.', status: 'OPEN',
          }],
        }),

        // Turn 5 — motivation answered, then completion.
        turn({
          recommended_action: 'COMPLETE_INTERVIEW',
          status: 'complete',
          question: null,
          candidate_message: 'Thank you — that is everything I needed. We will be in touch.',
          evidence_updates: [evidence('motivation', 'STRONG', 'Clear, specific interest in the platform remit.', REQ_IDS[1]!)],
          assessment_updates: [assessment('motivation', 'COVERED', 'HIGH', REQ_IDS[1]!)],
        }),
      ],
    });

    const api = request(h.app);
    const auth = (r: request.Test) => r.set('x-service-key', SERVICE_KEY);

    // ---- 1. create interview, 2. receive first question
    const created = await auth(api.post('/interviews').set('idempotency-key', 'k1')).send(createBody()).expect(201);
    const interviewId = created.body.interviewId as string;
    let questionId = created.body.question.id as string;
    expect(created.body.question.text).toBe('Tell me about your current role.');

    // ---- 3-6. five answering turns
    const answers = [
      'I lead the platform team.',
      'We migrated the billing service.',
      'I owned the architecture decision myself.',
      'We cut p95 latency by about 30 percent.',
      'I want deeper platform ownership.',
    ];
    let last: request.Response | null = null;
    for (let i = 0; i < answers.length; i += 1) {
      h.clock.advanceSeconds(120);
      const res = await auth(api.post(`/interviews/${interviewId}/responses`))
        .send({ questionId, answer: answers[i], idempotencyKey: `turn_${i + 1}` })
        .expect(200);
      last = res;
      if (res.body.question) questionId = res.body.question.id;
    }

    // ---- 10. interview completed
    expect(last!.body.status).toBe('complete');
    expect(last!.body.question).toBeUndefined();
    const interview = await h.container.interviews.load(interviewId);
    expect(interview!.status).toBe('COMPLETED');

    // ---- 7. the explicitly resolved gap is closed
    const gaps = (await h.pool.query(
      `SELECT gap_type, gap_class, status FROM evidence_gaps WHERE interview_id = $1 ORDER BY gap_type`,
      [interviewId],
    )).rows;
    const personal = gaps.find((g) => g.gap_type === 'PERSONAL_CONTRIBUTION');
    expect(personal!.status).toBe('RESOLVED');

    // ---- 8. the advisory gap the AI abandoned was auto-resolved, audited (A5)
    const depth = gaps.find((g) => g.gap_type === 'TECHNICAL_DEPTH');
    expect(depth!.gap_class).toBe('ADVISORY');
    expect(depth!.status).toBe('RESOLVED');
    const audits = await h.container.audit.forInterview(interviewId);
    expect(audits.map((a) => a.rule)).toContain('GAP_AUTO_RESOLVED');

    // ---- 9. assessment updates landed on both tracks
    const reqRows = await h.container.assessments.requirementRows(interviewId);
    const compRows = await h.container.assessments.competencyRows(interviewId);
    expect(reqRows.find((r) => r.requirement_id === REQ_IDS[0])!.coverage_level).toBe('COVERED');
    expect(compRows.find((c) => c.competency_tag === 'system_design')!.coverage_level).toBe('COVERED');

    // ---- 11. final assessment persisted, 12. retrievable
    const result = await auth(api.get(`/interviews/${interviewId}/result`)).expect(200);
    expect(result.body.scoringConfigVersion).toBe('1.1.0-mvp');
    expect(result.body.competencyScore).toBeGreaterThan(0);
    expect(result.body.overallRecommendation).toBeTruthy();
    // The one configured gate (system_design, MUST_HAVE + criticalGate) cleared.
    expect(result.body.criticalGateStatus).toBe('ALL_CLEARED');
    expect(result.body.recommendationRationale).toContain('Competency score');

    // ---- traceability: FinalAssessment -> Assessment -> Evidence -> Response
    //      -> Question -> Objective -> Requirement
    const chain = await h.pool.query(
      `SELECT fa.interview_id, ra.requirement_id, e.id AS evidence_id, cr.id AS response_id,
              q.id AS question_id, o.id AS objective_id, jr.id AS job_requirement_id
         FROM final_assessments fa
         JOIN requirement_assessments ra ON ra.interview_id = fa.interview_id
         JOIN evidence e                 ON e.requirement_id = ra.requirement_id
                                        AND e.interview_id = fa.interview_id
         JOIN candidate_responses cr     ON cr.id = e.source_response_id
         JOIN questions q                ON q.id = cr.question_id
         JOIN interview_objectives o     ON o.id = q.objective_id
         JOIN interview_objective_requirements oor ON oor.objective_id = o.id
         JOIN job_requirements jr        ON jr.id = oor.requirement_id
        WHERE fa.interview_id = $1`,
      [interviewId],
    );
    expect(chain.rows.length).toBeGreaterThan(0);
    for (const row of chain.rows) {
      for (const v of Object.values(row)) expect(v).toBeTruthy();
    }
  });

  it('exposes no scoring or assessment signal on the candidate-facing surface', async () => {
    h = await createHarness({
      steps: [
        { kind: 'respond', payload: initSuccess(REQ_IDS) },
        turn({
          evidence_updates: [evidence('system_design', 'STRONG', 'Owned it.', REQ_IDS[0]!)],
          assessment_updates: [assessment('system_design', 'COVERED', 'HIGH', REQ_IDS[0]!)],
          evidence_gap_updates: [{
            objective_ref: OBJ.design, gap_type: 'RESULT', description: 'no metric', status: 'OPEN',
          }],
        }),
      ],
    });
    const api = request(h.app);
    const auth = (r: request.Test) => r.set('x-service-key', SERVICE_KEY);

    const created = await auth(api.post('/interviews').set('idempotency-key', 'k1')).send(createBody()).expect(201);
    const id = created.body.interviewId as string;
    const turnRes = await auth(api.post(`/interviews/${id}/responses`))
      .send({ questionId: created.body.question.id, answer: 'I owned it.', idempotencyKey: 't1' })
      .expect(200);
    const status = await auth(api.get(`/interviews/${id}`)).expect(200);

    const forbidden = [
      'evidence', 'strength', 'coverage_level', 'confidence_band', 'operational_reasoning',
      'contradiction_status', 'gate', 'score', 'competency', 'reasoning', 'gap',
    ];
    for (const body of [created.body, turnRes.body, status.body]) {
      const json = JSON.stringify(body).toLowerCase();
      for (const f of forbidden) expect(json).not.toContain(f);
    }
    // The read endpoint returns only session-safe state.
    expect(status.body.progress.questionsAsked).toBeGreaterThan(0);
    expect(status.body.currentQuestion.id).toBeTruthy();
  });

  it('replays a turn without re-invoking the provider or double-writing', async () => {
    h = await createHarness({
      steps: [
        { kind: 'respond', payload: initSuccess(REQ_IDS) },
        turn({ evidence_updates: [evidence('system_design', 'STRONG', 'Owned it.', REQ_IDS[0]!)] }),
      ],
    });
    const api = request(h.app);
    const auth = (r: request.Test) => r.set('x-service-key', SERVICE_KEY);
    const created = await auth(api.post('/interviews').set('idempotency-key', 'k1')).send(createBody()).expect(201);
    const id = created.body.interviewId as string;
    const payload = { questionId: created.body.question.id, answer: 'I owned it.', idempotencyKey: 't1' };

    const first = await auth(api.post(`/interviews/${id}/responses`)).send(payload).expect(200);
    const callsAfter = h.provider.calls.length;
    const replay = await auth(api.post(`/interviews/${id}/responses`)).send(payload).expect(200);

    expect(replay.body).toEqual(first.body);
    expect(h.provider.calls.length).toBe(callsAfter);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM evidence WHERE interview_id = $1`, [id]);
    expect(rows[0]!.n).toBe(1);
  });
});
