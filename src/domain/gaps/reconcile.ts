/**
 * Evidence gap reconciliation — API_CONTRACT.md v3 §2.10, INTERVIEW_STATE.md v3 §7.
 *
 * Identity is (objectiveId, gapType), never normalized description text. That
 * gives at most one OPEN gap per pair, enforced by a partial unique index, and
 * needs no fuzzy matching.
 */
import type { EvidenceGap, ObjectiveId } from '../types/entities.ts';
import type { EvidenceGapType, GapStatus } from '../types/enums.ts';
import { classifyGap, type GapClass } from './classification.ts';

export interface GapUpdate {
  readonly objectiveId: ObjectiveId;
  readonly gapType: EvidenceGapType;
  readonly description: string;
  readonly status: GapStatus;
}

export type GapIntent =
  | { readonly kind: 'INSERT'; readonly objectiveId: ObjectiveId; readonly gapType: EvidenceGapType; readonly description: string; readonly gapClass: GapClass }
  | { readonly kind: 'REFRESH_DESCRIPTION'; readonly gapId: string; readonly description: string }
  | { readonly kind: 'RESOLVE'; readonly gapId: string; readonly reason: 'AI_RESOLVED' }
  | { readonly kind: 'NOOP'; readonly gapType: EvidenceGapType; readonly reason: 'NO_MATCHING_OPEN_GAP' };

const keyOf = (objectiveId: string, gapType: EvidenceGapType): string => `${objectiveId}::${gapType}`;

/**
 * Four branches, exactly as §7 specifies:
 *   OPEN + no existing OPEN row      -> INSERT
 *   OPEN + existing OPEN row         -> refresh description only, no duplicate row
 *   RESOLVED + matching OPEN row     -> resolve it
 *   RESOLVED + no matching OPEN row  -> no-op, logged, not an error
 */
export function reconcileGapUpdates(
  openGaps: readonly EvidenceGap[],
  updates: readonly GapUpdate[],
): GapIntent[] {
  const byKey = new Map<string, EvidenceGap>();
  for (const g of openGaps) {
    if (g.status === 'OPEN') byKey.set(keyOf(g.objectiveId, g.gapType), g);
  }

  const intents: GapIntent[] = [];
  for (const u of updates) {
    const existing = byKey.get(keyOf(u.objectiveId, u.gapType));
    if (u.status === 'OPEN') {
      if (existing) {
        intents.push({ kind: 'REFRESH_DESCRIPTION', gapId: existing.id, description: u.description });
      } else {
        intents.push({
          kind: 'INSERT',
          objectiveId: u.objectiveId,
          gapType: u.gapType,
          description: u.description,
          gapClass: classifyGap(u.gapType),
        });
      }
    } else if (existing) {
      intents.push({ kind: 'RESOLVE', gapId: existing.id, reason: 'AI_RESOLVED' });
    } else {
      intents.push({ kind: 'NOOP', gapType: u.gapType, reason: 'NO_MATCHING_OPEN_GAP' });
    }
  }
  return intents;
}
