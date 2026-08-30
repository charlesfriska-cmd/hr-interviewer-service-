/**
 * Deterministic gap auto-resolution — AMENDMENTS.md A5.
 *
 * Node.js is the authoritative owner of objective completion. An objective's
 * success must never depend solely on the model remembering to emit a gap-close
 * action, so once the substantive conditions hold, Node.js clears open gaps the
 * latest structured assessment no longer supports.
 *
 * Every auto-resolution is audited. Blocking gaps are never cleared this way
 * unless their own deterministic resolution rule is satisfied.
 */
import { auditIntent, type AuditIntent } from '../audit/auditIntent.ts';
import type { EvidenceGap } from '../types/entities.ts';
import type { ContradictionStatus, EvidenceGapType } from '../types/enums.ts';
import { classifyGap } from './classification.ts';

export interface AutoResolveInput {
  readonly objectiveId: string;
  /** Open gaps for this objective, after the turn's own updates were reconciled. */
  readonly openGaps: readonly EvidenceGap[];
  /** True when conditions 1-3 of the SATISFIED rule hold for this objective. */
  readonly substantiveConditionsMet: boolean;
  /** Gap types the latest turn re-asserted as OPEN — still supported, never cleared. */
  readonly reassertedGapTypes: ReadonlySet<EvidenceGapType>;
  /** The latest turn's contradiction_status — the resolution rule for CONTRADICTION gaps. */
  readonly contradictionStatus: ContradictionStatus;
}

export interface AutoResolveResult {
  readonly resolvedGapIds: string[];
  readonly retainedGapIds: string[];
  readonly audit: AuditIntent[];
}

/**
 * A blocking gap clears only when its own rule is satisfied. For CONTRADICTION
 * that rule is the turn's contradiction_status reaching RESOLVED — the same
 * signal INTERVIEW_STATE.md §8.2 already aggregates, so no new judgment is
 * introduced and none is delegated to the model beyond what it already reports.
 */
function blockingRuleSatisfied(
  gapType: EvidenceGapType,
  contradictionStatus: ContradictionStatus,
): boolean {
  if (gapType === 'CONTRADICTION') return contradictionStatus === 'RESOLVED';
  // A blocking type with no deterministic rule defined is never auto-resolved.
  return false;
}

export function autoResolveGaps(input: AutoResolveInput): AutoResolveResult {
  const resolvedGapIds: string[] = [];
  const retainedGapIds: string[] = [];
  const audit: AuditIntent[] = [];

  // Auto-resolution is a completion-time tidy-up, not a running behaviour: with
  // the substantive conditions unmet, every open gap still describes something
  // genuinely outstanding.
  if (!input.substantiveConditionsMet) {
    return { resolvedGapIds: [], retainedGapIds: input.openGaps.map((g) => g.id), audit: [] };
  }

  for (const gap of input.openGaps) {
    if (gap.status !== 'OPEN') continue;

    // Re-asserted this turn: the assessment still supports it, so it stands.
    if (input.reassertedGapTypes.has(gap.gapType)) {
      retainedGapIds.push(gap.id);
      continue;
    }

    const gapClass = classifyGap(gap.gapType);
    if (gapClass === 'BLOCKING') {
      if (!blockingRuleSatisfied(gap.gapType, input.contradictionStatus)) {
        retainedGapIds.push(gap.id);
        continue;
      }
      resolvedGapIds.push(gap.id);
      audit.push(
        auditIntent('GUARDRAIL_OVERRIDE', 'GAP_AUTO_RESOLVED', {
          gapId: gap.id,
          objectiveId: input.objectiveId,
          gapType: gap.gapType,
          gapClass,
          basis: 'BLOCKING_RULE_SATISFIED',
          contradictionStatus: input.contradictionStatus,
        }),
      );
      continue;
    }

    resolvedGapIds.push(gap.id);
    audit.push(
      auditIntent('GUARDRAIL_OVERRIDE', 'GAP_AUTO_RESOLVED', {
        gapId: gap.id,
        objectiveId: input.objectiveId,
        gapType: gap.gapType,
        gapClass,
        basis: 'NOT_SUPPORTED_BY_LATEST_ASSESSMENT',
      }),
    );
  }

  return { resolvedGapIds, retainedGapIds, audit };
}
