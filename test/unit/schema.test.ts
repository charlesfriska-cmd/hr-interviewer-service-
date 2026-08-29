import { describe, expect, it } from 'vitest';
import { validateDecision } from '../../src/llm/schema/dispatch.ts';
import {
  initializationDecisionSchema,
  turnDecisionSchema,
} from '../../src/llm/schema/decisions.schema.ts';
import { EVIDENCE_STRENGTH, CONFIDENCE_BAND } from '../../src/domain/types/enums.ts';

const validInit = {
  candidate_message: 'Thanks for joining. To start, tell me about your current role.',
  objectives: [
    {
      ref: 'obj_1',
      phase: 'OPENING',
      requirement_ids: ['req_1'],
      competency_tag: 'communication',
      target_evidence_count: 1,
    },
  ],
  first_question: {
    objective_ref: 'obj_1',
    competency: 'communication',
    question_type: 'opening',
    text: 'Tell me about your current role.',
  },
  operational_reasoning: { objective: 'Establish context', evidence_gap: 'None yet' },
};

const validTurn = {
  status: 'in_progress',
  recommended_action: 'FOLLOW_UP',
  candidate_message: 'Thanks — what was your specific role in that migration?',
  question: {
    phase: 'COMPETENCY_DEEP_DIVE',
    objective: 'obj-uuid-1',
    competency: 'system_design',
    question_type: 'behavioral_follow_up',
    text: 'What was your specific decision-making role versus the team’s?',
  },
  evidence_updates: [
    {
      requirement_id: 'req_003',
      competency: 'system_design',
      summary: 'Led architecture decisions for a service migration.',
      strength: 'MODERATE',
    },
  ],
  assessment_updates: [
    {
      requirement_id: 'req_003',
      competency: 'system_design',
      coverage_level: 'PARTIALLY_COVERED',
      confidence_band: 'MODERATE',
    },
  ],
  evidence_gap_updates: [
    {
      objective_ref: 'obj-uuid-1',
      gap_type: 'MEASURABLE_OUTCOME',
      description: 'No quantified result stated.',
      status: 'OPEN',
    },
  ],
  operational_reasoning: {
    objective: 'Establish individual contribution',
    evidence_gap: 'Answer described team outcome, not individual ownership',
  },
  contradiction_status: 'NONE',
  progress: { objectives_completed: 2, objectives_total: 5 },
};

describe('mode dispatch (C1)', () => {
  it('validates a well-formed initialization decision', () => {
    expect(validateDecision('initialization', validInit).valid).toBe(true);
  });

  it('validates a well-formed turn decision', () => {
    expect(validateDecision('turn', validTurn).valid).toBe(true);
  });

  it('rejects a turn payload submitted under initialization mode', () => {
    expect(validateDecision('initialization', validTurn).valid).toBe(false);
  });

  it('accepts a null question (COMPLETE_INTERVIEW shape)', () => {
    const complete = { ...validTurn, recommended_action: 'COMPLETE_INTERVIEW', question: null };
    expect(validateDecision('turn', complete).valid).toBe(true);
  });
});

describe('closed enums are enforced at runtime', () => {
  it('rejects an out-of-set evidence strength', () => {
    const bad = structuredClone(validTurn);
    bad.evidence_updates[0]!.strength = 'EXCELLENT';
    const r = validateDecision('turn', bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('strength');
  });

  it('accepts every declared EvidenceStrength value', () => {
    for (const s of EVIDENCE_STRENGTH) {
      const ok = structuredClone(validTurn);
      ok.evidence_updates[0]!.strength = s;
      expect(validateDecision('turn', ok).valid).toBe(true);
    }
  });

  it('accepts every declared ConfidenceBand value', () => {
    for (const b of CONFIDENCE_BAND) {
      const ok = structuredClone(validTurn);
      ok.assessment_updates[0]!.confidence_band = b;
      expect(validateDecision('turn', ok).valid).toBe(true);
    }
  });

  it('rejects an unknown evidence gap type', () => {
    const bad = structuredClone(validTurn);
    bad.evidence_gap_updates[0]!.gap_type = 'VIBES';
    expect(validateDecision('turn', bad).valid).toBe(false);
  });
});

describe('the AI has no field for a score or a gate (§24 schema-level guarantee)', () => {
  const serialised = JSON.stringify([initializationDecisionSchema, turnDecisionSchema]);

  it('declares no score field anywhere in either schema', () => {
    expect(serialised).not.toMatch(/"score"/);
  });

  it('declares no gate field anywhere in either schema', () => {
    expect(serialised.toLowerCase()).not.toMatch(/gate/);
  });

  it('rejects an injected numeric score even when otherwise valid', () => {
    const injected = { ...validTurn, competency_score: 5 };
    expect(validateDecision('turn', injected).valid).toBe(false);
  });

  it('rejects an injected gate judgment even when otherwise valid', () => {
    const injected = structuredClone(validTurn) as Record<string, unknown>;
    (injected.assessment_updates as Array<Record<string, unknown>>)[0]!.is_critical_gate = true;
    expect(validateDecision('turn', injected).valid).toBe(false);
  });
});

describe('required fields and additionalProperties', () => {
  it('rejects a missing required field', () => {
    const bad = structuredClone(validTurn) as Record<string, unknown>;
    delete bad.contradiction_status;
    expect(validateDecision('turn', bad).valid).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    expect(validateDecision('turn', { ...validTurn, surprise: 1 }).valid).toBe(false);
  });

  it('rejects a model-invented objective UUID format in initialization refs', () => {
    // refs must be present; an empty ref is malformed (C2 ref-uniqueness path).
    const bad = structuredClone(validInit);
    bad.objectives[0]!.ref = '';
    expect(validateDecision('initialization', bad).valid).toBe(false);
  });
});
