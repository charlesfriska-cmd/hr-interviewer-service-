# INTERVIEW_STATE.md
## Authoritative State Machine, Lifecycle, Guardrails & Aggregation Contract

Status: Authoritative technical contract, **v2**. Supersedes `INTERVIEW_STATE.md` v1 (indexed
as `INTERVIEW_STATE-1.md`). Closes implementation blockers C9, C11, C15, and reflects the C2/C5/
C10/C12/C13/C16 changes made canonical in `API_CONTRACT.md` v2.

---

## 1. Scope Boundary (unchanged)

**Node.js decides what the system is allowed to do. The AI decides what is intelligent to do
within those boundaries.**

---

## 2. Interview State Machine

### 2.1 States (unchanged)

```typescript
type InterviewStatus =
  | "INITIALIZING" | "PRE_INTERVIEW_ANALYSIS" | "OPENING" | "EXPERIENCE_VALIDATION"
  | "COMPETENCY_DEEP_DIVE" | "MOTIVATION_FIT" | "CLARIFICATION" | "CLOSING"
  | "COMPLETED" | "TERMINATED" | "ERROR";

type InterviewPhase = Exclude<InterviewStatus,
  "INITIALIZING" | "PRE_INTERVIEW_ANALYSIS" | "COMPLETED" | "TERMINATED" | "ERROR">;
```

### 2.2 Transition Authority Table (amended — C9: forced completion from any active phase)

| Transition | Trigger | Who moves it |
|---|---|---|
| `INITIALIZING → PRE_INTERVIEW_ANALYSIS` | Interview + inputs persisted | Node.js only, always fires |
| `PRE_INTERVIEW_ANALYSIS → OPENING` | Valid `InitializationDecision` received | AI produces it; Node.js applies only after Ajv + rules-engine pass (includes ref→UUID minting, `API_CONTRACT.md` §2.3) |
| `OPENING → EXPERIENCE_VALIDATION` | `MOVE_NEXT` recommended | AI recommends; Node.js decides. **No hard phase cap forces this anymore (C15)** — see §4a. |
| `EXPERIENCE_VALIDATION → COMPETENCY_DEEP_DIVE` | same pattern | AI recommends; Node.js decides |
| `COMPETENCY_DEEP_DIVE → MOTIVATION_FIT` | same pattern | AI recommends; Node.js decides |
| `MOTIVATION_FIT → CLARIFICATION` | `CLARIFY`/`MOVE_NEXT` recommended, or unresolved-gap count > 0 at cap | AI recommends; Node.js decides |
| `CLARIFICATION → CLOSING` | `COMPLETE_INTERVIEW` recommended, or a hard global guardrail fires | Node.js has final authority |
| **`{OPENING \| EXPERIENCE_VALIDATION \| COMPETENCY_DEEP_DIVE \| MOTIVATION_FIT \| CLARIFICATION} → CLOSING` (NEW, C9)** | Any hard global guardrail fires (`MAX_QUESTIONS_REACHED`, `TIME_EXHAUSTED`, or an explicit forced-completion condition) **regardless of current phase** | **Node.js only, unconditionally.** This generalizes the v1 table, which only allowed a forced jump from `CLARIFICATION → CLOSING`. A time/question exhaustion event during, say, `EXPERIENCE_VALIDATION` now transitions directly to `CLOSING` rather than requiring the state machine to first walk through every intermediate phase. |
| `CLOSING → COMPLETED` | Assessment aggregation finalized | Node.js only, always fires |
| `ANY (non-terminal) → TERMINATED` | Recruiter action, or candidate timeout | Node.js only |
| `ANY (non-terminal) → ERROR` | Unrecoverable validation/provider failure after retries | Node.js only |

**Resolution (C9):** the forced-completion path is no longer keyed to the current phase being
`CLARIFICATION`. Any phase can jump directly to `CLOSING` the moment a hard global guardrail
fires. This matches real interview dynamics — an interview can exhaust its question budget
mid-`COMPETENCY_DEEP_DIVE`, for instance, and should close gracefully from there rather than
being modeled as needing to pass through `MOTIVATION_FIT`/`CLARIFICATION` first. Every such
forced transition writes exactly one `AuditEvent(type=STATE_TRANSITION, actor=SYSTEM_FORCED)`
naming the guardrail that fired (Section 4), and the candidate always receives one graceful
closing `candidate_message` (either the AI's own proactive `COMPLETE_INTERVIEW` recommendation
if it got there first, or a deterministic closing message if Node.js had to force it before the
AI recommended it).

Within a phase, `FOLLOW_UP` / `CLARIFY` / `DEEP_DIVE` are intra-phase: they may change
`InterviewState.currentObjectiveId` but never `currentPhase`.

---

## 3. `InterviewState` — Lifecycle & Field Ownership

```typescript
interface InterviewState {
  interviewId: string;
  currentPhase: InterviewStatus;
  currentObjectiveId: string | null;
  questionsAskedCount: number;
  followUpsByObjective: Record<string, number>;
  phaseElapsedSeconds: Record<InterviewPhase, number>;  // NEW (C15)
  unresolvedGapIds: string[];                            // now references EvidenceGap.id rows (§7 below), not free text
  lastQuestionId: string | null;
  version: number;
  updatedAt: string;
}
```

**Write path (every turn, in order) — unchanged from v1 except step 2 now also computes
`phaseBudgetStatus`:**

1. Node.js loads `InterviewState` with its current `version`.
2. Node.js computes `phaseBudgetStatus` for the current phase (§4a) and builds `TurnRequest`
   from `InterviewState` + relevant `Evidence` + `EvidenceGapRef[]` (from `EvidenceGap` rows
   with `status == OPEN` for the current objective) + `InterviewPlan` objective data — never
   from a prior turn's `TurnDecision` (the LLM remains stateless).
3. AI returns `TurnDecision`; Node.js validates (Ajv → rules engine).
4. Node.js computes the **final action** (Section 4) — which may differ from
   `recommended_action`.
5. Node.js writes the new `InterviewState` row (including updated `phaseElapsedSeconds`) with
   `WHERE version = :expected`. A mismatch aborts with `409`.

`unresolvedGapIds` derivation: recomputed each turn as the set of `EvidenceGap.id` with
`status == "OPEN"` for this interview, after applying that turn's `evidence_gap_updates`
(reconciliation rule in `API_CONTRACT.md` §2.10). The AI never writes this array directly.

---

## 4. Guardrail Override Table (amended — C15 removes hard `PHASE_CAP_REACHED`, C9 generalizes forced completion)

| Condition (checked in this order) | Override applied | AuditEvent |
|---|---|---|
| `followUpsUsedForObjective >= maxFollowUpsPerObjective` AND `recommended_action` ∈ {`FOLLOW_UP`,`DEEP_DIVE`,`CLARIFY`} | Force `MOVE_NEXT` | `GUARDRAIL_OVERRIDE`, rule = `MAX_FOLLOWUPS_REACHED` |
| `questionsAskedCount >= maxQuestions` | Force `COMPLETE_INTERVIEW` → transition directly to `CLOSING` from whatever phase is current (C9) | `GUARDRAIL_OVERRIDE`, rule = `MAX_QUESTIONS_REACHED` |
| `remainingTimeMinutes <= 0` | Force `COMPLETE_INTERVIEW` → transition directly to `CLOSING` from whatever phase is current (C9) | `GUARDRAIL_OVERRIDE`, rule = `TIME_EXHAUSTED` |
| `question.competency` or `question.objective` not in this interview's registry | Retry-once path (Section 6) | `VALIDATION_FAILURE` |
| `recommended_action == COMPLETE_INTERVIEW` but one or more MUST_HAVE objectives are still `PENDING`/`IN_PROGRESS` with follow-up budget remaining | Downgrade to `MOVE_NEXT` on the highest-priority unresolved MUST_HAVE objective | `GUARDRAIL_OVERRIDE`, rule = `PREMATURE_COMPLETION_BLOCKED` |
| Only `INSUFFICIENT`-strength evidence (or none) when an objective closes | Force `insufficientEvidenceFlag = true` regardless of AI's `coverage_level` | `GUARDRAIL_OVERRIDE`, rule = `INSUFFICIENT_EVIDENCE_FORCED` |
| ~~Phase question-cap or phase time-cap reached~~ **REMOVED (C15)** | — no hard override exists any longer — | — |
| Phase soft budget exceeded (§4a) | **No override.** Node.js sets `phaseBudgetStatus = OVER_BUDGET` in the next `TurnRequest.constraints`; this is advisory input to the AI's own prioritization, never a forced action. | none (not a guardrail event — it's informational context, not a correction) |
| Candidate inactivity past configured timeout | Force `ANY → TERMINATED` | `STATE_TRANSITION`, actor = `SYSTEM_TIMEOUT` |
| `evidence_updates[].summary`, `operational_reasoning.*`, `evidence_gap_updates[].description`, or `candidate_message` matches the protected-characteristic denylist | Redact matched term in stored copy; turn proceeds otherwise unmodified | `GUARDRAIL_OVERRIDE`, rule = `PROTECTED_CHARACTERISTIC_FILTERED` |
| AI-proposed objective `ref` missing/duplicate/malformed at initialization | Retry-once path; on second failure, standard fallback | `VALIDATION_FAILURE` |
| Evidence gap update references an unknown `objective_ref`, or `gap_type` outside the closed enum | Drop that single gap update (log it), do not fail the whole turn | `GUARDRAIL_OVERRIDE`, rule = `INVALID_GAP_UPDATE_DROPPED` |

**Rule ordering:** hard resource exhaustion (questions/time) always outranks interview-quality
guardrails. A turn is never double-overridden with two competing reasons.

### 4a. Phase Soft Budgets (C15 — replaces hard phase caps)

**Resolution:** deterministic **global** guardrails remain hard limits: `maxDurationMinutes`,
`maxQuestions`, `maxFollowUpsPerObjective`, and manual termination. Per-phase time/question
*allocation* (the "3–5 min opening, 10–15 min experience validation," etc. targets from
`INTERVIEW_FRAMEWORK.md` §4) is downgraded from a hard cap to a **soft budget** used only for AI
prioritization signaling.

Mechanism:

1. Each `InterviewPhase` has an expected share of the overall budget, expressed as a percentage
   of `maxDurationMinutes` and/or `maxQuestions` (config-driven, e.g. Opening 10%, Experience
   Validation 25%, Competency Deep Dive 35%, Motivation Fit 15%, Clarification 15%).
2. On every turn, Node.js compares `InterviewState.phaseElapsedSeconds[currentPhase]` (and/or
   the question count spent in that phase) against that phase's expected share.
3. If actual usage exceeds the expected share, Node.js sets
   `TurnRequest.constraints.phaseBudgetStatus = "OVER_BUDGET"`; otherwise `"ON_TRACK"`.
4. The AI is instructed (`HR_INTERVIEWER_SYSTEM_PROMPT.md` v1.1) to treat `OVER_BUDGET` as a
   nudge to prioritize the highest-value remaining item and lean toward `MOVE_NEXT` sooner — it
   is never told, and Node.js never enforces, that the phase must end.
5. **No automatic termination or forced phase transition occurs merely because a soft budget
   was exceeded.** The interview may legitimately spend more of its overall time in one phase
   than the default allocation suggests, if that is where the genuine evidence gaps are — the
   only things that can force a transition are the hard global guardrails in Section 4 and
   the phase-appropriate `MOVE_NEXT`/`COMPLETE_INTERVIEW` recommendation path.

`PHASE_CAP_REACHED` as a hard-enforced rule is removed from this document and from
`ARCHITECTURE.md` §6/§13 (those sections should be read as amended: "Node.js phase-timeout/
question-cap reached" language describing a *forcing* mechanism no longer applies; phase
allocation is advisory only).

---

## 5. Context Optimization — What Is (and Isn't) Sent Per Turn

Unchanged from v1, with one addition: `TurnRequest.unresolvedGaps` is now `EvidenceGapRef[]`
(structured: `gapType` + `description`), not a `string[]` (C11) — see `API_CONTRACT.md` §4.1.

| Layer | Contents | Sent to LLM on a turn? |
|---|---|---|
| Original raw data | Full CV text, full JD text | Never |
| Structured derived (once) | `CandidateProfileSummary`, `CompactRequirement[]` | Sent once, at init only |
| `InterviewPlan` | Full objective list | Never resent in full; referenced by canonical id in `currentObjective` |
| Rolling per-turn context | Current phase, current objective, current-objective-only evidence, current-objective-only `EvidenceGapRef[]`, current Q + latest A, `DeterministicConstraints` (incl. `phaseBudgetStatus`) | Sent every turn |
| Historical archive | Full transcript, full cross-objective evidence/gap history | Never sent to the turn loop |

---

## 6. Retry, Fallback & Concurrency (consolidated — now backed by `TurnOperation`, C10/C12/C13)

| Failure | Handling | Resulting state |
|---|---|---|
| Ajv schema validation fails | One retry with a corrective note; on second failure → fallback | `TurnOperation.status = FAILED_RETRYABLE` (or `FAILED_FINAL` for init after 3 attempts) |
| Fallback (both attempts exhausted) | Deterministic "technical difficulty, please hold" `candidate_message`; `AuditEvent(type=VALIDATION_FAILURE)`; recruiter-visible flag raised | `InterviewState` **unchanged** — no question slot consumed, no state moved |
| LLM transport error/timeout | Adapter retries up to 2× with backoff; exhausted → same fallback path | `InterviewState` unchanged, operation `FAILED_RETRYABLE` |
| `interview_state.version` mismatch on write | Abort, no server-side retry | `409`; client re-fetches and resubmits with the **same** `idempotencyKey` — this resumes the same `TurnOperation` row (`API_CONTRACT.md` §5), it does not create a parallel one |
| Duplicate submission, same `idempotencyKey`, operation `SUCCEEDED` | Short-circuit, return cached `responseBody` | Cached prior result, no new LLM call, no new mutation |
| Duplicate submission, same `idempotencyKey`, operation `FAILED_RETRYABLE` | Resume: reuse the already-durable `CandidateResponse`, do not insert a second one, re-run from the LLM-call step | Operation moves back to `PROCESSING` → `SUCCEEDED`/`FAILED_RETRYABLE`/`FAILED_FINAL` |
| Duplicate submission, same `idempotencyKey`, operation `PROCESSING` | Concurrent in-flight request | `409` |
| Duplicate submission, same `questionId`, no/different `idempotencyKey` | Rejected — `lastQuestionId` will already have advanced | `409` |

**Why the candidate's answer always survives a downstream failure:** unchanged principle from
v1 — `CandidateResponse` commits in its own short transaction before the LLM is called. The
`TurnOperation` record (§5 of `API_CONTRACT.md`) is what now makes this guarantee auditable and
resumable as an explicit state machine rather than an implicit behavior.

---

## 7. Evidence Gap Lifecycle (C11)

```
Turn N:   AI emits evidence_gap_updates: [{ objective_ref, gap_type, description, status }]
             │
             ▼
Node.js: for each update, match on (objectiveId, gapType) against existing EvidenceGap rows
             │
             ├─ status="OPEN",  no existing OPEN row for this key  → INSERT new EvidenceGap(status=OPEN)
             ├─ status="OPEN",  existing OPEN row for this key     → UPDATE description only (no new row)
             ├─ status="RESOLVED", matching OPEN row exists        → UPDATE that row: status=RESOLVED, resolvedAt=now()
             └─ status="RESOLVED", no matching OPEN row            → no-op (logged, not an error)
             │
             ▼
InterviewState.unresolvedGapIds := { EvidenceGap.id : status="OPEN" for this interview }
             │
             ▼
Next turn's TurnRequest.unresolvedGaps := EvidenceGapRef[] filtered to the CURRENT objective only
```

At finalization, `RequirementAssessment.gapIds` / `CompetencyAssessment.gapIds` (both
requirement- and competency-linked via the objective's `requirementIds`/`competencyTag`) are
populated from all `EvidenceGap` rows tied to that objective, regardless of open/resolved
status — the final record preserves the full gap history for audit, even though only `OPEN`
gaps are ever sent back to the LLM mid-interview.

---

## 8. Evidence → Assessment → Final Assessment Aggregation Pipeline (amended — C5, C6, C7, C8)

```
Per turn:                TurnDecision.evidence_updates      ──► Evidence rows (persisted)
                          TurnDecision.assessment_updates    ──► RequirementAssessment/CompetencyAssessment
                                                                  .coverageLevel + .confidenceBand updated (rolling, directional)
                                                                  requirement_id != null → updates BOTH requirement + linked competency rollup (C16)
                                                                  requirement_id == null → updates competency rollup ONLY (C16)
                                                                  .score stays null throughout the interview
                          TurnDecision.evidence_gap_updates  ──► EvidenceGap rows (§7 above)
                          TurnDecision.contradiction_status  ──► accumulated per turn for finalization (§8.2)

At CLOSING → COMPLETED:  Node.js reads ALL persisted Evidence + EvidenceGap rows for this
                          interview (never raw transcript) ──► deterministic final-assessment
                          computation (no LLM call) produces, in this order:

                          1. RequirementAssessment.score (1–5) per the rubric in
                             SCORING_FRAMEWORK.md §7.1, contributing ONLY to Requirement Fit.
                          2. CompetencyAssessment.score (1–5) per the same rubric, contributing
                             ONLY to Competency Score (C5 — these two are never blended).
                          3. CompetencyAssessment.rating derived from .score via the threshold
                             table in scoring.config.ts (C7) — never model-supplied, never
                             exact-value-equality logic.
                          4. Gate evaluation (C4): for every RequirementAssessment/
                             CompetencyAssessment where the linked JobRequirement.criticalGate
                             or competency isCriticalGate is true, compute gateStatus
                             (CLEARED/FAILED/INSUFFICIENT_DATA). Non-gate items get
                             gateStatus = NOT_A_GATE.
                          5. competencyScore = weighted average across CompetencyAssessment
                             rows only (SCORING_FRAMEWORK.md §5).
                          6. overallRecommendation = f(competencyScore, mustHaveGateStatus,
                             overallConfidenceBand) — Requirement Fit and gate status can only
                             CAP the recommendation derived from competencyScore, never raise
                             it; Nice-to-Have performance never enters this function at all (C6).
                          7. keyStrengths / concerns / recommendationRationale /
                             RequirementAssessment.notes / CompetencyAssessment.rationale
                             assembled by deterministic template from stored evidence + scores +
                             gaps (C8) — no LLM call.
                          8. contradictions assembled from per-turn contradiction_status flags.
                          9. FinalAssessment assembled (API_CONTRACT.md §2.9) and persisted once.
```

### 8.1 Deterministic Scoring Rubric (unchanged mechanism, now explicitly dual-tracked per C5)

The lookup table from v1 (highest evidence strength attained × final coverage level → 1–5) is
unchanged and is applied **independently** to requirement-linked evidence (producing
`RequirementAssessment.score`) and competency-linked evidence (producing
`CompetencyAssessment.score`). These are two separate applications of the same table, not one
shared computation — this is what makes the "no double counting" guarantee in C5 hold: a single
piece of evidence can inform both a requirement score and a competency score (since evidence
carries both `requirementId` and `competencyTag`), but the two resulting scores are never
summed or averaged together into one number.

Full weighting formula, gate-capping rule, and `scoring.config.ts` shape: `SCORING_FRAMEWORK.md`
§2a, §5.

### 8.2 Contradiction Aggregation (unchanged from v1)

Per-turn `contradiction_status` (`NONE`/`RESOLVED`/`UNRESOLVED`) is walked at finalization; one
`FinalAssessment.contradictions` entry per turn where the status is not `NONE`.

---

## 9. Resolved Inconsistencies Log (v2 additions)

| # | Inconsistency | Resolution |
|---|---|---|
| 10 | Hard `PHASE_CAP_REACHED` guardrail conflicted with `INTERVIEW_FRAMEWORK.md`'s framing of phase durations as targets, not limits | Downgraded to a soft, advisory `phaseBudgetStatus` signal; only global guardrails remain hard (§4a) |
| 11 | Forced completion previously modeled as only reachable from `CLARIFICATION` | Generalized to any active phase → `CLOSING` when a hard global guardrail fires (§2.2) |
| 12 | `unresolvedGapIds` derivation source was free-text and dedup-ambiguous | Backed by a real `EvidenceGap` entity keyed on `(objectiveId, gapType)` (§7) |
| 13 | Idempotency described as an implicit cache with no explicit failure-state model | Backed by an explicit `TurnOperation` state machine (§6; full shape in `API_CONTRACT.md` §5) |
| 14 | `RequirementAssessment`/`CompetencyAssessment` scoring risked double-counting the same evidence into one blended average | Split into independent Competency Score and Requirement Fit computations (§8) |

(Items 1–9 from v1 remain resolved and unchanged; see `INTERVIEW_STATE.md` v1 for that history,
retained in `API_CONTRACT.md` §9 index for cross-reference.)

---

## 10. Formerly-Open Decisions — Now Closed (C9–C16, state-machine-relevant subset)

| # | Item | Final decision | Owner | MVP scope |
|---|---|---|---|---|
| C9 | Forced completion transition | Any active phase → `CLOSING` → `COMPLETED` on hard guardrail; always audited | Node.js | Full behavior in MVP |
| C11 | Evidence gap lifecycle | `EvidenceGap` entity, `(objectiveId, gapType)` dedup key, explicit open/resolve reconciliation | Shared (AI proposes, Node.js applies) | Full behavior in MVP |
| C15 | Phase limits | Global guardrails remain hard; phase allocation becomes a soft `phaseBudgetStatus` signal only | Node.js | Full behavior in MVP |
| C10/C12/C13 | Idempotency/retry | `TurnOperation` state machine, no separate `turn_results` table | Node.js | Full behavior in MVP |

No implementation-blocking decision remains in this document.

---

*End of INTERVIEW_STATE.md v2. See `API_CONTRACT.md` v2 for exact data shapes and
`SCORING_FRAMEWORK.md` v2 for the scoring configuration.*
