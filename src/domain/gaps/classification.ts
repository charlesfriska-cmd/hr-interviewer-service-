/**
 * Evidence gap classification — AMENDMENTS.md A5.
 *
 * Gaps emitted by the AI are advisory assessment signals, not authoritative
 * blockers. Only gaps whose type carries a deterministic resolution rule of its
 * own are treated as blocking; everything else informs the interview without
 * being able to silently invert an objective's outcome.
 *
 * Classification is deterministic and Node-owned. The AI has no field to declare
 * a gap blocking, consistent with every other authority boundary in the system.
 */
import type { EvidenceGapType } from '../types/enums.ts';

export type GapClass = 'BLOCKING' | 'ADVISORY';

/**
 * CONTRADICTION is blocking: an unreconciled contradiction materially degrades
 * the credibility of an assessment (INTERVIEW_FRAMEWORK.md §15), and it has a
 * deterministic resolution rule — the turn's own contradiction_status — so it can
 * be cleared without guessing.
 *
 * Every other gap type describes a missing element. Absence of an element is
 * already expressed by coverage level and evidence strength, which are the
 * signals scoring actually consumes; letting it also block completion would
 * double-count the same fact and make a successful objective depend on the model
 * remembering to close a note it opened.
 */
const BLOCKING_GAP_TYPES: ReadonlySet<EvidenceGapType> = new Set<EvidenceGapType>([
  'CONTRADICTION',
]);

export function classifyGap(gapType: EvidenceGapType): GapClass {
  return BLOCKING_GAP_TYPES.has(gapType) ? 'BLOCKING' : 'ADVISORY';
}

export function isBlockingGap(gapType: EvidenceGapType): boolean {
  return classifyGap(gapType) === 'BLOCKING';
}
