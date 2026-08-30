# CONTRACT_ADDENDUM v3.1
## Authoritative amendment for A1, A2, A5

Status: **Authoritative contract addendum.** Amends `API_CONTRACT.md` v3,
`INTERVIEW_STATE.md` v3, and `SCORING_FRAMEWORK.md` v3 in the three places named
below. Every other clause of those documents stands unchanged. Term meanings
continue to come from `DOMAIN_GLOSSARY.md`.

No architectural change is made here: no new agent, no new service, no new
infrastructure, no change to either AI response schema, and no change to the
`TurnOperation`, gate, or scoring-track models.

---

## A1 — Canonical `Question` model restored

`API_CONTRACT.md` v3 §2.8 restated `Question` under the heading "amended — B4"
and listed only the two B4 additions. The restatement silently omitted fields
present in v1/v2, without the explicit removal note the same document uses
elsewhere (§2.6 marks B1's deletions as "**Removed (B1):** … deleted from this
interface entirely"). The omission is treated as an editorial accident, not a
field removal.

**Canonical `Question` (supersedes the v3 §2.8 restatement):**

```typescript
interface Question {
  id: string;                  // [NODE][IMMUTABLE]
  interviewId: string;         // [NODE][IMMUTABLE]
  objectiveId: string;         // [NODE][IMMUTABLE] — canonical Node-minted UUID (§2.3)
  phase: InterviewPhase;       // [NODE][IMMUTABLE]
  text: string;                // [NODE][IMMUTABLE] — validated AI-authored question text
  presentedAt: string;         // [NODE][IMMUTABLE] — B4 clock start; source of Interview.startedAt for question #1
  sequenceNumber: number;      // [DERIVED]  — RESTORED (A1)
  competencyTag: string | null;// [AI-REC]   — RESTORED (A1)
  questionType: string;        // [AI-REC]   — RESTORED (A1)
}
```

Rationale for each restored field:

- **`sequenceNumber`** — carries the `UNIQUE (interview_id, sequence_number)`
  constraint, which is what makes a double-applied turn impossible at the storage
  layer rather than merely unlikely. It is also the stable ordering key for
  `GET /interviews/{id}/transcript`.
- **`competencyTag`**, **`questionType`** — both are still emitted by the model in
  `TurnDecision.question` and `InitializationDecision.first_question`. Not
  persisting them would discard validated audit data the AI contract requires the
  model to produce, breaking the §25 traceability chain at the question link.

**`CandidateResponse`** is confirmed as v3 §2.8 states it. The two v2 field changes
there are deliberate and stand: `rawText`/`submittedAt` are renamed
`answerText`/`receivedAt`, and `idempotencyKey` is correctly absent — `TurnOperation`
has owned idempotency since C10/C12/C13, so a second key on the response row would
be a duplicate source of truth.

**Amends:** `API_CONTRACT.md` v3 §2.8.

---

## A2 — Null competency score terminates in `INSUFFICIENT_DATA`

`SCORING_FRAMEWORK.md` v3 §8.2 directed a null `competencyScore` to "skip directly
to §8.5". Taken literally that branch has no defined output: §8.5's effect is
`tier = min(tier, "CONSIDER")`, and `tier` is never assigned because §8.2 was
skipped.

**Canonical rule (amends §8.2):**

> If `competencyScore` is `null`, `overallRecommendation` is `INSUFFICIENT_DATA`,
> subject to the existing finalization rules. **No recommendation tier may be
> inferred from a null score.**

A null score means no competency ever reached adequate evidence, which is
`DOMAIN_GLOSSARY`'s definition of `INSUFFICIENT_DATA` — a process outcome, not a
judgment on the candidate. Tiering compares a score against thresholds; with no
score there is nothing to compare, so falling through to a tier would report a
verdict the interview never produced.

**Evaluation order.** The check runs after §8.3's critical-gate
`INSUFFICIENT_DATA` override so that gate risk flags are still recorded. Both
paths terminate at `INSUFFICIENT_DATA`, so ordering cannot change the
recommendation — only the completeness of the flags accompanying it.

**Amends:** `SCORING_FRAMEWORK.md` v3 §8.2.

---

## A5 — Node.js owns objective completion; gaps are advisory signals

`INTERVIEW_STATE.md` v3 §5a condition 4 required that **no** `EvidenceGap` remain
`OPEN` before an objective could reach `SATISFIED`. Because gaps are opened and
closed solely by the model's `evidence_gap_updates`, and nothing obliges the model
to close a gap it opened, an objective that genuinely succeeded could be recorded
as `INSUFFICIENT_EVIDENCE` — excluded from the weighted average (§5.3), inflating
`unverifiedAreas`, and capping the recommendation via §8.5.

**Governing principle (consistent with every other authority boundary):** evidence
gaps emitted by the AI are advisory assessment signals, not authoritative
blockers by themselves. Node.js is the authoritative owner of objective
completion.

### A5.1 Gap classification — Node-owned, deterministic

Every `EvidenceGap` carries a Node-derived class. The AI has no field to declare a
gap blocking and cannot influence the classification.

| Class | Gap types | Effect |
|---|---|---|
| `BLOCKING` | `CONTRADICTION` | Holds an objective back from `SATISFIED`; auto-resolves only when its own deterministic rule is satisfied |
| `ADVISORY` | all other `EvidenceGapType` values | Informs the interview; never blocks completion on its own; eligible for auto-resolution |

`CONTRADICTION` is blocking because an unreconciled contradiction materially
degrades assessment credibility (`INTERVIEW_FRAMEWORK.md` §15) **and** it has a
deterministic resolution rule already in the contract — the turn's own
`contradiction_status`. Every other type describes a missing element, which
`coverageLevel` and `EvidenceStrength` already express; letting it also block
completion would double-count the same fact.

### A5.2 Amended `SATISFIED` rule (replaces §5a condition 4)

An objective transitions `IN_PROGRESS → SATISFIED` when:

1. the required coverage threshold is met (MVP default `COVERED`);
2. at least one usable, non-`INSUFFICIENT` evidence item exists;
3. `targetEvidenceCount` is met, where configured;
4. **no explicitly blocking unresolved gap remains.**

Conditions 1–3 are the *substantive* criteria and are evaluated as a unit.

### A5.3 Deterministic auto-resolution

When conditions 1–3 are satisfied, Node.js auto-resolves open gaps for that
objective as follows:

| Gap state | Action |
|---|---|
| Re-asserted `OPEN` by the latest turn's `evidence_gap_updates` | **Retained** — the latest structured assessment still supports it |
| `ADVISORY`, not re-asserted | **Auto-resolved**, basis `NOT_SUPPORTED_BY_LATEST_ASSESSMENT` |
| `BLOCKING`, resolution rule satisfied (`CONTRADICTION` with `contradiction_status == "RESOLVED"`) | **Auto-resolved**, basis `BLOCKING_RULE_SATISFIED` |
| `BLOCKING`, rule not satisfied | **Retained** — never auto-resolved |

While conditions 1–3 are unmet, no auto-resolution occurs at all: every open gap
still describes something genuinely outstanding.

**Auditing is mandatory.** Every auto-resolution writes exactly one
`AuditEvent(type = GUARDRAIL_OVERRIDE, rule = GAP_AUTO_RESOLVED)` recording the
gap id, objective id, gap type, gap class, and the basis above — so "why did this
gap close" is answerable from audit data alone, without inspecting model output.

**Objective success never depends solely on the LLM emitting a gap-close action.**

**Amends:** `INTERVIEW_STATE.md` v3 §5a and §7; `API_CONTRACT.md` v3 §2.10
(`EvidenceGap` gains a Node-derived `gapClass`; `status` may now be set to
`RESOLVED` by deterministic Node.js action as well as by an AI-emitted update).

---

## Implementation index

| Amendment | Modules | Tests |
|---|---|---|
| A1 | `src/domain/types/entities.ts` | typecheck |
| A2 | `src/domain/scoring/recommendation.ts` | `test/unit/recommendation.test.ts` |
| A5 | `src/domain/gaps/{classification,reconcile,autoResolve}.ts`, `src/domain/state/objectiveStatus.ts`, `src/domain/audit/auditIntent.ts` | `test/unit/gaps.test.ts`, `test/unit/objectiveStatus.test.ts` |

*End of CONTRACT_ADDENDUM v3.1.*
