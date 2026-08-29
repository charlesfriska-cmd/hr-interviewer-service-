/**
 * Mode -> schema dispatch — API_CONTRACT.md v3 §3.1 (C1).
 *
 * One agent, one prompt, two schemas. This is the only place the mapping lives.
 * Both validators compile at startup, so a malformed schema crashes the process
 * at boot rather than at the first candidate turn.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { initializationDecisionSchema, turnDecisionSchema } from './decisions.schema.ts';

export type LLMMode = 'initialization' | 'turn';

const ajv = new Ajv({ allErrors: true, strict: true });

const validators: Record<LLMMode, ValidateFunction> = {
  initialization: ajv.compile(initializationDecisionSchema),
  turn: ajv.compile(turnDecisionSchema),
};

export interface ValidationOutcome {
  readonly valid: boolean;
  readonly errors: string[];
}

/**
 * Validates a raw provider payload against the schema its mode selects. Returns
 * errors rather than throwing: an invalid decision is a retry-then-fallback path
 * (INTERVIEW_STATE.md §6), not an exception.
 */
export function validateDecision(mode: LLMMode, raw: unknown): ValidationOutcome {
  const validate = validators[mode];
  const valid = validate(raw) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
  );
  return { valid: false, errors };
}
