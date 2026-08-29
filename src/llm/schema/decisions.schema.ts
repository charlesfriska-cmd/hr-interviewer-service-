/**
 * Ajv schemas for both AI response shapes — API_CONTRACT.md v3 §4.2/§4.3.
 *
 * Every `enum` below is spread from the single `as const` array in
 * domain/types/enums.ts, so the TypeScript union and the runtime schema can never
 * disagree. `additionalProperties: false` everywhere and every field required:
 * the provider's own structured-output guarantee is an optimization, never the
 * trust boundary (ARCHITECTURE.md §17).
 *
 * Neither schema contains a numeric score field or any gate field, in either
 * direction. That is what makes "even a successful prompt injection cannot
 * produce a score or a gate judgment" a schema-level guarantee (§24).
 */
import {
  CONFIDENCE_BAND,
  CONTRADICTION_STATUS,
  COVERAGE_LEVEL,
  EVIDENCE_GAP_TYPE,
  EVIDENCE_STRENGTH,
  GAP_STATUS,
  INTERVIEW_PHASE,
  RECOMMENDED_ACTION,
} from '../../domain/types/enums.ts';

const nonEmptyString = { type: 'string', minLength: 1 } as const;

const operationalReasoning = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'evidence_gap'],
  properties: {
    objective: { type: 'string' },
    evidence_gap: { type: 'string' },
  },
} as const;

/** §4.2 — initialization mode. `ref` values are response-local (C2). */
export const initializationDecisionSchema = {
  $id: 'https://hr-interviewer/schemas/initialization-decision.json',
  type: 'object',
  additionalProperties: false,
  required: ['candidate_message', 'objectives', 'first_question', 'operational_reasoning'],
  properties: {
    candidate_message: nonEmptyString,
    objectives: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'phase', 'requirement_ids', 'competency_tag', 'target_evidence_count'],
        properties: {
          ref: nonEmptyString,
          phase: { type: 'string', enum: [...INTERVIEW_PHASE] },
          requirement_ids: { type: 'array', items: { type: 'string' } },
          competency_tag: nonEmptyString,
          // Rules-engine clamps to 1-4; the schema accepts the wider integer range
          // so a clampable value is a guardrail correction, not a failed turn.
          target_evidence_count: { type: 'integer', minimum: 0 },
        },
      },
    },
    first_question: {
      type: 'object',
      additionalProperties: false,
      required: ['objective_ref', 'competency', 'question_type', 'text'],
      properties: {
        objective_ref: nonEmptyString,
        competency: nonEmptyString,
        question_type: nonEmptyString,
        text: nonEmptyString,
      },
    },
    operational_reasoning: operationalReasoning,
  },
} as const;

/** §4.3 — turn mode. `objective` / `objective_ref` are canonical UUIDs here. */
export const turnDecisionSchema = {
  $id: 'https://hr-interviewer/schemas/turn-decision.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'recommended_action',
    'candidate_message',
    'question',
    'evidence_updates',
    'assessment_updates',
    'evidence_gap_updates',
    'operational_reasoning',
    'contradiction_status',
    'progress',
  ],
  properties: {
    status: { type: 'string', enum: ['in_progress', 'complete'] },
    recommended_action: { type: 'string', enum: [...RECOMMENDED_ACTION] },
    candidate_message: nonEmptyString,
    // null iff recommended_action == COMPLETE_INTERVIEW — cross-field rule enforced
    // by the rules engine, since JSON Schema cannot express it cleanly alongside
    // additionalProperties: false.
    question: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['phase', 'objective', 'competency', 'question_type', 'text'],
          properties: {
            phase: { type: 'string', enum: [...INTERVIEW_PHASE] },
            objective: nonEmptyString,
            competency: nonEmptyString,
            question_type: nonEmptyString,
            text: nonEmptyString,
          },
        },
      ],
    },
    evidence_updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement_id', 'competency', 'summary', 'strength'],
        properties: {
          requirement_id: { type: ['string', 'null'] },
          competency: nonEmptyString,
          summary: nonEmptyString,
          strength: { type: 'string', enum: [...EVIDENCE_STRENGTH] },
        },
      },
    },
    assessment_updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement_id', 'competency', 'coverage_level', 'confidence_band'],
        properties: {
          // null -> competency rollup only; non-null -> both rollups (C16).
          requirement_id: { type: ['string', 'null'] },
          competency: nonEmptyString,
          coverage_level: { type: 'string', enum: [...COVERAGE_LEVEL] },
          confidence_band: { type: 'string', enum: [...CONFIDENCE_BAND] },
        },
      },
    },
    evidence_gap_updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['objective_ref', 'gap_type', 'description', 'status'],
        properties: {
          objective_ref: nonEmptyString,
          gap_type: { type: 'string', enum: [...EVIDENCE_GAP_TYPE] },
          description: nonEmptyString,
          status: { type: 'string', enum: [...GAP_STATUS] },
        },
      },
    },
    operational_reasoning: operationalReasoning,
    contradiction_status: { type: 'string', enum: [...CONTRADICTION_STATUS] },
    progress: {
      type: 'object',
      additionalProperties: false,
      required: ['objectives_completed', 'objectives_total'],
      properties: {
        objectives_completed: { type: 'integer', minimum: 0 },
        objectives_total: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;
