import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness, createBody, SERVICE_KEY, type Harness } from './harness.ts';
import { initSuccess, type MockStep } from '../../src/llm/providers/mock/MockHRInterviewerProvider.ts';

const REQ_IDS = ['pos-c1_req_1', 'pos-c1_req_2'];
const OBJ = { opening: 'obj-c1', design: 'obj-c2', motivation: 'obj-c3' };

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const completeTurn = (over: Record<string, unknown> = {}): MockStep => ({
  kind: 'respond',
  payload: {
    status: 'complete',
    recommended_action: 'COMPLETE_INTERVIEW',
    candidate_message: 'Thank you, that is everything.',
    question: null,
    evidence_updates: [],
    assessment_updates: [],
    evidence_gap_updates: [],
    operational_reasoning: { objective: 'close', evidence_gap: 'none' },
    contradiction_status: 'NONE',
    progress: { objectives_completed: 3, objectives_total: 3 },
    ...over,
  },
});

/**
 * These tests exercise finalization, not pacing, so they run with no follow-up
 * budget: PREMATURE_COMPLETION_BLOCKED is scoped to objectives that still have
 * budget remaining, so a COMPLETE_INTERVIEW recommendation is applied directly.
 */
const finalizationBody = (over: Record<string, unknown> = {}) =>
  createBody({ maxFollowUpsPerObjective: 0, ...over });

/** Drives create -> answering turns -> completion, returning the result body. */
async function runTo(harness: Harness, body = finalizationBody()) {
  const api = request(harness.app);
  const auth = (r: request.Test) => r.set('x-service-key', SERVICE_KEY);
  const created = await auth(api.post('/interviews').set('idempotency-key', 'k1')).send(body).expect(201);
  const id = created.body.interviewId as string;
  let questionId = created.body.question.id as string;

  for (let i = 0; i < 2; i += 1) {
    harness.clock.advanceSeconds(60);
    const res = await auth(api.post(`/interviews/${id}/responses`))
      .send({ questionId, answer: `answer ${i}`, idempotencyKey: `t${i}` })
      .expect(200);
    if (res.body.question) questionId = res.body.question.id;
    if (res.body.status === 'complete') break;
  }
  const result = await auth(api.get(`/interviews/${id}/result`)).expect(200);
  return { id, result: result.body as Record<string, unknown> };
}

describe('deterministic finalization', () => {
  it('caps the recommendation at CONSIDER when a critical gate fails', async () => {
    h = await createHarness({
      steps: [
        { kind: 'respond', payload: initSuccess(REQ_IDS) },
        // Strong communication, but the gated system_design requirement scores low.
        completeTurn({
          status: 'in_progress',
          recommended_action: 'FOLLOW_UP',
          question: {
            phase: 'COMPETENCY_DEEP_DIVE', objective: OBJ.design, competency: 'system_design',
            question_type: 'behavioral', text: 'Tell me more.',
          },
          evidence_updates: [
            { requirement_id: null, competency: 'communication', summary: 'Very clear, structured answers throughout.', strength: 'VERY_STRONG' },
            { requirement_id: REQ_IDS[0], competency: 'system_design', summary: 'Generic claim, no specifics.', strength: 'VERY_WEAK' },
          ],
          assessment_updates: [
            { requirement_id: null, competency: 'communication', coverage_level: 'COVERED', confidence_band: 'VERY_HIGH' },
            { requirement_id: REQ_IDS[0], competency: 'system_design', coverage_level: 'COVERED', confidence_band: 'HIGH' },
          ],
        }),
        completeTurn(),
      ],
    });
    const { result } = await runTo(h);

    expect(result.criticalGateStatus).toBe('ONE_OR_MORE_FAILED');
    // Capping only ever lowers: a strong competency score cannot lift it back.
    expect(['CONSIDER', 'NOT_RECOMMENDED']).toContain(result.overallRecommendation);
    expect((result.riskFlags as string[]).join(' ')).toContain('failed');
  });

  it('returns INSUFFICIENT_DATA when a critical gate was never attempted', async () => {
    h = await createHarness({
      steps: [
        { kind: 'respond', payload: initSuccess(REQ_IDS) },
        // Only the opening competency is evidenced; the gated requirement is
        // never reached, so its gate is INSUFFICIENT_DATA, not FAILED.
        completeTurn({
          evidence_updates: [
            { requirement_id: null, competency: 'communication', summary: 'Clear and well structured.', strength: 'STRONG' },
          ],
          assessment_updates: [
            { requirement_id: null, competency: 'communication', coverage_level: 'COVERED', confidence_band: 'HIGH' },
          ],
        }),
      ],
    });
    const { result } = await runTo(h);

    expect(result.criticalGateStatus).toBe('ONE_OR_MORE_INSUFFICIENT');
    // A hard override, not a cap — an untested non-negotiable must never appear
    // under a positive-flavoured tier.
    expect(result.overallRecommendation).toBe('INSUFFICIENT_DATA');
    expect((result.riskFlags as string[]).join(' ')).toContain('never reached adequate evidence');
    expect(result.recommendationRationale).toContain('process outcome');
  });

  it('reports unverified areas, distinguishing never-reached from attempted', async () => {
    h = await createHarness({
      steps: [
        { kind: 'respond', payload: initSuccess(REQ_IDS) },
        completeTurn({
          evidence_updates: [
            { requirement_id: null, competency: 'communication', summary: 'Clear.', strength: 'STRONG' },
          ],
          assessment_updates: [
            { requirement_id: null, competency: 'communication', coverage_level: 'COVERED', confidence_band: 'HIGH' },
          ],
        }),
      ],
    });
    const { result } = await runTo(h);
    const unverified = (result.unverifiedAreas as string[]).join(' | ');
    expect(unverified).toContain('not reached');
    expect(unverified).toContain('system_design');
  });

  it('never promotes on nice-to-have performance (C6)', async () => {
    // A NICE_TO_HAVE requirement with no gate; strong evidence on it must not
    // lift the recommendation derived from the competency score.
    const body = finalizationBody({
      requirements: [
        { label: 'Core design', priority: 'MUST_HAVE', competencyTag: 'system_design' },
        { label: 'Kubernetes', priority: 'NICE_TO_HAVE', competencyTag: 'infra' },
      ],
    });
    h = await createHarness({
      steps: [
        { kind: 'respond', payload: initSuccess(REQ_IDS) },
        completeTurn({
          evidence_updates: [
            { requirement_id: REQ_IDS[0], competency: 'system_design', summary: 'Adequate but unquantified.', strength: 'MODERATE' },
            { requirement_id: REQ_IDS[1], competency: 'motivation', summary: 'Deep Kubernetes work with measured results.', strength: 'VERY_STRONG' },
          ],
          assessment_updates: [
            { requirement_id: REQ_IDS[0], competency: 'system_design', coverage_level: 'PARTIALLY_COVERED', confidence_band: 'MODERATE' },
            { requirement_id: REQ_IDS[1], competency: 'motivation', coverage_level: 'COVERED', confidence_band: 'VERY_HIGH' },
          ],
        }),
      ],
    });
    const { result } = await runTo(h, body);

    // Nice-to-have appears as context only.
    expect((result.niceToHaveHighlights as string[]).join(' ')).toContain('Kubernetes');
    expect(result.overallRecommendation).not.toBe('STRONGLY_RECOMMENDED');
  });

  it('records the scoring config version so a recalibration cannot reinterpret it', async () => {
    h = await createHarness({
      steps: [
        { kind: 'respond', payload: initSuccess(REQ_IDS) },
        completeTurn({
          evidence_updates: [{ requirement_id: null, competency: 'communication', summary: 'Clear.', strength: 'STRONG' }],
          assessment_updates: [{ requirement_id: null, competency: 'communication', coverage_level: 'COVERED', confidence_band: 'HIGH' }],
        }),
      ],
    });
    const { id, result } = await runTo(h);
    expect(result.scoringConfigVersion).toBe('1.1.0-mvp');

    // Finalization is idempotent and persisted exactly once.
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM final_assessments WHERE interview_id = $1`, [id]);
    expect(rows[0]!.n).toBe(1);
  });

  it('rejects a result read before the interview completes', async () => {
    h = await createHarness({ steps: [{ kind: 'respond', payload: initSuccess(REQ_IDS) }] });
    const api = request(h.app);
    const created = await api.post('/interviews').set('x-service-key', SERVICE_KEY)
      .set('idempotency-key', 'k1').send(finalizationBody()).expect(201);
    await api.get(`/interviews/${created.body.interviewId}/result`)
      .set('x-service-key', SERVICE_KEY).expect(409);
  });
});
