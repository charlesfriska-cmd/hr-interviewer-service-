/**
 * Deterministic guardrail engine — INTERVIEW_STATE.md v3 §4.
 *
 * Rules are an ORDERED array evaluated first-match-wins, so §4's precedence note
 * ("hard resource exhaustion always outranks interview-quality guardrails; a turn
 * is never double-overridden with two competing reasons") is a property of the
 * data structure rather than of the reading order of an if-chain.
 *
 * Pure: no I/O, no clock, no persistence. Everything it needs arrives in the
 * context so that every rule is directly testable.
 */
import { auditIntent, type AuditIntent } from '../audit/auditIntent.ts';
import type { RecommendedAction } from '../types/enums.ts';

export interface RuleContext {
  readonly recommendedAction: RecommendedAction;
  readonly questionsAskedCount: number;
  readonly maxQuestions: number;
  readonly elapsedActiveInterviewSeconds: number;
  readonly maxDurationMinutes: number;
  readonly followUpsUsedForObjective: number;
  readonly maxFollowUpsPerObjective: number;
  /** Objective ids that are MUST_HAVE-linked and still PENDING/IN_PROGRESS. */
  readonly unresolvedMustHaveObjectiveIds: readonly string[];
  /** False when question.objective or question.competency is outside the registry. */
  readonly referencesValid: boolean;
}

export type RuleOutcome =
  | {
      readonly kind: 'RETRY';
      readonly rule: 'UNKNOWN_REFERENCE';
      readonly audit: AuditIntent[];
    }
  | {
      readonly kind: 'APPLY';
      readonly finalAction: RecommendedAction;
      readonly appliedRule: string | null;
      readonly audit: AuditIntent[];
    };

const PROBING_ACTIONS: ReadonlySet<RecommendedAction> = new Set<RecommendedAction>([
  'FOLLOW_UP',
  'DEEP_DIVE',
  'CLARIFY',
]);

interface Rule {
  readonly name: string;
  readonly applies: (c: RuleContext) => boolean;
  readonly action: (c: RuleContext) => RecommendedAction;
}

/**
 * Order is load-bearing.
 *
 * Global resource exhaustion sits above the per-objective follow-up cap: with the
 * question or time budget spent, forcing MOVE_NEXT would schedule a question the
 * interview has no room to ask. §4's precedence note governs here over the
 * table's listing order, which reads followups-first only because that row was
 * written before C9 generalised forced completion.
 */
const ORDERED_RULES: readonly Rule[] = [
  {
    name: 'MAX_QUESTIONS_REACHED',
    applies: (c) => c.questionsAskedCount >= c.maxQuestions,
    action: () => 'COMPLETE_INTERVIEW',
  },
  {
    name: 'TIME_EXHAUSTED',
    applies: (c) => c.elapsedActiveInterviewSeconds >= c.maxDurationMinutes * 60,
    action: () => 'COMPLETE_INTERVIEW',
  },
  {
    name: 'MAX_FOLLOWUPS_REACHED',
    applies: (c) =>
      c.followUpsUsedForObjective >= c.maxFollowUpsPerObjective &&
      PROBING_ACTIONS.has(c.recommendedAction),
    action: () => 'MOVE_NEXT',
  },
  {
    // Quality guardrail: never let the interview close while a MUST_HAVE objective
    // is still open and there is budget left to pursue it.
    name: 'PREMATURE_COMPLETION_BLOCKED',
    applies: (c) =>
      c.recommendedAction === 'COMPLETE_INTERVIEW' &&
      c.unresolvedMustHaveObjectiveIds.length > 0 &&
      c.followUpsUsedForObjective < c.maxFollowUpsPerObjective,
    action: () => 'MOVE_NEXT',
  },
];

export function evaluateGuardrails(context: RuleContext): RuleOutcome {
  // Reference validation precedes every override: an unknown objective or
  // competency tag is a schema-adjacent failure routed to retry-then-fallback,
  // not a decision to correct.
  if (!context.referencesValid) {
    return {
      kind: 'RETRY',
      rule: 'UNKNOWN_REFERENCE',
      audit: [
        auditIntent('VALIDATION_FAILURE', 'UNKNOWN_REFERENCE', {
          recommendedAction: context.recommendedAction,
        }),
      ],
    };
  }

  for (const rule of ORDERED_RULES) {
    if (!rule.applies(context)) continue;
    const finalAction = rule.action(context);
    // A rule that does not change the action is not an override and is not audited
    // as one — otherwise every capped turn would log a correction it did not make.
    if (finalAction === context.recommendedAction) break;
    return {
      kind: 'APPLY',
      finalAction,
      appliedRule: rule.name,
      audit: [
        auditIntent('GUARDRAIL_OVERRIDE', rule.name, {
          originalAction: context.recommendedAction,
          appliedAction: finalAction,
        }),
      ],
    };
  }

  return {
    kind: 'APPLY',
    finalAction: context.recommendedAction,
    appliedRule: null,
    audit: [],
  };
}
