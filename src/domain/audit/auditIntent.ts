/**
 * Audit intents — ARCHITECTURE.md §25.
 *
 * Produced by the pure domain layer and written by the application layer's
 * AuditWriter. Deciding what gets audited belongs with the rule that fired, not
 * with the call site that happens to persist it.
 */

export type AuditEventType =
  | 'STATE_TRANSITION'
  | 'AI_CALL'
  | 'VALIDATION_FAILURE'
  | 'GUARDRAIL_OVERRIDE'
  | 'HUMAN_OVERRIDE'
  | 'ERROR';

export interface AuditIntent {
  readonly type: AuditEventType;
  /** Names the specific rule that fired, so "why did it do that" is answerable. */
  readonly rule?: string;
  /** Structured metadata only — never raw chain-of-thought (ARCHITECTURE.md §25). */
  readonly payload: Record<string, unknown>;
}

export const auditIntent = (
  type: AuditEventType,
  rule: string | undefined,
  payload: Record<string, unknown>,
): AuditIntent => (rule === undefined ? { type, payload } : { type, rule, payload });
