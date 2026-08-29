# INTERVIEW_STATE.md
## Authoritative State Machine, Lifecycle, Guardrails & Aggregation Contract

Status: Authoritative technical contract, **v3**. Supersedes `INTERVIEW_STATE.md` v2. Closes
implementation blockers B3 (lease semantics), B4 (active vs. idle time), B5 (objective status
lifecycle refinement), and B6 (finalization determinism, mechanics side — schema side is
`SCORING_FRAMEWORK.md` v3). Sections not listed below are **unchanged from v2**. See
`DOMAIN_GLOSSARY.md` for canonical term meanings.

---

## Amendment index

| Blocker | Section(s) added/changed |
|---|---|
| B3 | §6 (retry table, PROCESSING row now lease-aware) |
| B4 | §4b (NEW — Active Interview Time & Session Idle Time), §4 guardrail table (time trigger source clarified) |
| B5 | §5a (NEW — Objective Status Lifecycle, `genuineAttempt`) |
| B6 | §8 (aggregation pipeline — deterministic finalization algorithm pointer + confidence ordering + gate terminology) |

---

## 2.2 Transition Authority Table — unchanged from v2

The forced-completion generalization (C9) and all other rows are unchanged. The **trigger
source** for `TIME_EXHAUSTED` is amended by §4b below (active time, not wall-clock time); the
transition mechanics themselves are unchanged.

---

## 4. Guardrail Override Table (amended row — B4 trigger source only)

All rows are unchanged from v2 **except** the time-exhaustion trigger's definition:

| Condition (checked in this order) | Override applied | AuditEvent |
|---|---|---|
| `followUpsUsedForObjective >= maxFollowUpsPerObjective` AND `recommended_action` ∈ {`FOLLOW_UP`,`DEEP_DIVE`,`CLARIFY`} | Force `MOVE_NEXT` | `GUARDRAIL_OVERRIDE`, rule = `MAX_FOLLOWUPS_REACHED` |
| `questionsAskedCount >= maxQuestions` | Force `COMPLETE_INTERVIEW` → `CLOSING` from current phase | `GUARDRAIL_OVERRIDE`, rule = `MAX_QUESTIONS_REACHED` |
| **`elapsedActiveInterviewSeconds >= maxDurationMinutes * 60`** (CHANGED, B4 — was: wall-clock `remainingTimeMinutes <= 0` measured from `startedAt`) | Force `COMPLETE_INTERVIEW` → `CLOSING` from current phase | `GUARDRAIL_OVERRIDE`, rule = `TIME_EXHAUSTED` |
| *(all remaining rows unchanged from v2 — objective registry validation, premature completion, insufficient evidence forcing, phase soft budget informational-only, candidate inactivity → TERMINATED, protected-characteristic redaction, malformed ref retry, invalid gap update drop)* | | |

**Why this matters:** under v2's literal wording, a candidate who left a tab open for an hour
mid-answer could have silently burned the entire interview's wall-clock budget before ever
submitting. Under B4, only genuinely-spent, clamped answering time counts against
`maxDurationMinutes` — see §4b for the exact accumulation rule. The **separate** inactivity
guardrail (`ANY → TERMINATED` on candidate inactivity, unchanged row from v2) is what actually
protects against an abandoned session running forever; it now explicitly reads
`lastActivityAt` against `sessionIdleTimeoutMinutes` rather than being loosely specified.

---

## 4b. Active Interview Time & Session Idle Time (NEW, B4)

Two independent clocks. Neither substitutes for the other.

### Active Interview Time

**Purpose:** the only clock `maxDurationMinutes`, `remainingTimeMinutes`, and phase soft budgets
are checked against.

**Field lifecycle:**

1. When Node.js persists a new outstanding question, it sets `Question.presentedAt = now()`
   (`API_CONTRACT.md` v3 §2.8). This is the turn's clock start.
2. When the candidate's answer is accepted and durably persisted, Node.js sets
   `CandidateResponse.receivedAt = now()` (same write transaction as the pre-existing
   durable-answer-before-LLM-call step — no new transaction boundary is introduced).
3. Node.js computes, for that turn:
   ```
   turnActiveSeconds = min(
     receivedAt - presentedAt,
     Interview.maxCandidateResponseWindowSeconds
   )
   ```
4. Node.js accumulates:
   ```
   InterviewState.elapsedActiveInterviewSeconds += turnActiveSeconds
   InterviewState.phaseElapsedSeconds[currentPhaseAtTimeOfQuestion] += turnActiveSeconds
   ```
   Both accumulations happen in the same write as step 5 of the existing per-turn write path
   (`INTERVIEW_STATE.md` v2 §3, unchanged ordering) — no separate transaction.
5. `remainingTimeMinutes` sent in the next `TurnRequest.constraints` is derived as:
   ```
   remainingTimeMinutes = max(0, maxDurationMinutes - elapsedActiveInterviewSeconds / 60)
   ```
6. `phaseBudgetStatus` (unchanged mechanism from v2 §4a) now compares
   `phaseElapsedSeconds[currentPhase]` — active seconds — against the phase's configured share.
   No change to the soft-budget mechanism itself, only to what feeds it.

**Clamp rationale:** `maxCandidateResponseWindowSeconds` (`API_CONTRACT.md` v3 §2.1) bounds how
much of a single turn's real elapsed time can count as "the candidate was actively answering."
A candidate who takes 45 minutes to answer one question (idle tab, interruption, etc.) still only
consumes `maxCandidateResponseWindowSeconds` of budget for that turn, not the full 45 minutes —
this is what prevents idle time from being laundered into active time.

**Initialization/pre-first-question time:** the interval between `Interview.createdAt` and
`Interview.startedAt` (plan generation) is never counted as active interview time — it has no
`Question.presentedAt` to anchor it, by construction.

### Session Idle / Expiration Time

**Purpose:** decide whether the *session itself* should end due to inactivity, independent of
how much active-time budget remains.

**Field lifecycle:**

- `InterviewState.lastActivityAt` is updated to `now()` whenever: a `CandidateResponse` is
  accepted, or (for the very first question) the moment `Interview.startedAt` is set. It is
  **not** updated merely by the passage of time, and it is never derived from
  `elapsedActiveInterviewSeconds`.
- The pre-existing guardrail row "Candidate inactivity past configured timeout → Force `ANY →
  TERMINATED`" (`INTERVIEW_STATE.md` v2 §4, unchanged transition) now has an explicit,
  deterministic trigger: `now() - lastActivityAt >= sessionIdleTimeoutMinutes * 60`. On firing,
  `Interview.terminatedReason = "SESSION_IDLE_EXPIRED"` (`API_CONTRACT.md` v3 §2.1).
- This check is independent of `elapsedActiveInterviewSeconds`/`maxDurationMinutes` — a session
  can be well within its active-time budget and still be idle-expired, and conversely reaching
  `maxDurationMinutes` is handled entirely by the `TIME_EXHAUSTED` guardrail (§4 above), never by
  the idle-timeout path.

**`startedAt` / `lastActivityAt` / `questionPresentedAt` — exact moments, restated for clarity:**

| Field | Set when |
|---|---|
| `Interview.createdAt` | The `Interview` row is first inserted (`POST /interviews` accepted) |
| `Interview.startedAt` | The first `Question.presentedAt` — i.e., the moment the validated `InitializationDecision`'s first question is persisted as the interview's outstanding question, completing `PRE_INTERVIEW_ANALYSIS → OPENING` |
| `Question.presentedAt` (any question) | The instant that specific question is persisted as the current outstanding question |
| `CandidateResponse.receivedAt` | The instant that answer is durably persisted (pre-LLM-call write) |
| `InterviewState.lastActivityAt` | Refreshed at `Interview.startedAt` and at every subsequent `CandidateResponse.receivedAt` |

---

## 5a. Objective Status Lifecycle (NEW, B5)

Canonical state machine for `InterviewObjective.status` (schema unchanged — `API_CONTRACT.md`
§2.3):

```
PENDING → IN_PROGRESS → SATISFIED
                       → INSUFFICIENT_EVIDENCE
```

There is no path back from `SATISFIED`/`INSUFFICIENT_EVIDENCE` to an earlier state — both are
terminal for that objective within this interview (a recruiter override that edits the plan,
§ARCHITECTURE.md §26, is the only exception, and is out of scope for MVP per the deferred
plan-editing endpoint).

### `PENDING → IN_PROGRESS`

Fires the instant the **first candidate-facing question associated with that objective is
persisted** (i.e., that objective's first `Question.presentedAt` is set — the same event that
may also set `Interview.startedAt` if this is the interview's very first question overall).

### `IN_PROGRESS → SATISFIED`

Evaluated after every successfully applied turn (i.e., every time a `TurnDecision` is validated
and its `assessment_updates`/`evidence_updates` are persisted for this objective). **All** of the
following must hold — evidence count alone is never sufficient:

1. The objective's rolled-up `coverageLevel` has reached the configured "sufficient" level
   (MVP default: `COVERED`; `PARTIALLY_COVERED` alone never satisfies this rule).
2. At least one persisted `Evidence` row for this objective has a strength other than
   `INSUFFICIENT` (i.e., at least one genuinely usable evidence item exists — not merely an
   attempted question with no usable answer).
3. `targetEvidenceCount` (`InterviewObjective.targetEvidenceCount`) is met, where the objective
   has one configured (objectives with no meaningful target — e.g. brief-validation objectives
   per `INTERVIEW_FRAMEWORK.md` §2 — are satisfied by rule 1+2 alone).
4. No `EvidenceGap` row for this objective remains `status == OPEN` at the time of evaluation.

If all four hold, Node.js sets `status = SATISFIED`. This check runs deterministically in
Node.js against persisted data — it never trusts the AI's own `coverage_level` claim in
isolation (consistent with the pre-existing "schema-valid ≠ trusted-to-apply" principle).

### `IN_PROGRESS → INSUFFICIENT_EVIDENCE`

Fires when Node.js must **close out** the objective (stop expecting further turns on it) without
the `SATISFIED` criteria above being met, for any of these documented terminal conditions:

- `followUpsUsedForObjective >= maxFollowUpsPerObjective` and the objective is being left via a
  forced/recommended `MOVE_NEXT` (`MAX_FOLLOWUPS_REACHED`, §4).
- A deterministic global guardrail fires (`MAX_QUESTIONS_REACHED`, `TIME_EXHAUSTED`) while this
  objective is `IN_PROGRESS` and unresolved.
- Phase progression occurs (the interview moves past this objective's phase) while it remains
  `IN_PROGRESS` and unresolved — including the C9 forced-`CLOSING` path.
- The candidate refused to answer, or gave no usable evidence, for every question asked on this
  objective (`INTERVIEW_FRAMEWORK.md` §16 edge cases), and no further budget/rationale exists to
  continue probing it.
- Any other documented terminal path that closes the objective without the four `SATISFIED`
  conditions holding.

An objective must never be left `PENDING` at interview close if it was ever presented to the
candidate — it must land in exactly one of `SATISFIED`/`INSUFFICIENT_EVIDENCE` by the time
`CLOSING → COMPLETED` runs. An objective that was genuinely never reached (still `PENDING` at
close, e.g. a low-priority Nice-to-Have objective the interview ran out of budget for before
ever asking about it) remains `PENDING` and is reported in `unverifiedAreas` as "not reached,"
distinct from an `INSUFFICIENT_EVIDENCE` objective that *was* attempted.

### `genuineAttempt` (NEW, B5 — canonical definition)

```
genuineAttempt(objective) == true  iff
    objective.status != "PENDING"   // i.e., it reached at least IN_PROGRESS
    AND at least one Question exists with objective.id == this objective's id
```

This definition is the deterministic input to:
- **Premature completion protection** (`INTERVIEW_STATE.md` v2 §4, `PREMATURE_COMPLETION_BLOCKED`
  row, unchanged mechanism): a MUST_HAVE objective without a `genuineAttempt` and with follow-up
  budget remaining blocks premature `COMPLETE_INTERVIEW`.
- **`unverifiedAreas`** (`FinalAssessment`, unchanged shape): an objective is listed as "not
  reached" if `genuineAttempt == false`, versus "insufficient evidence despite attempt" if
  `genuineAttempt == true` and `status == INSUFFICIENT_EVIDENCE` — these are reported with
  distinct phrasing so a recruiter can tell "we never got to this" from "we tried and it didn't
  resolve."
- **Final scoring minimum-evidence logic** (`SCORING_FRAMEWORK.md` v3 §5.3, unchanged rule,
  now formally keyed to this definition): an item without a `genuineAttempt` is excluded from
  weighted averages exactly as an `INSUFFICIENT_EVIDENCE` item would be, and is flagged
  `INSUFFICIENT_DATA` at the gate/requirement-fit level where applicable.

---

## 6. Retry, Fallback & Concurrency (amended — B3: PROCESSING lease)

Unchanged rows from v2 except the two `PROCESSING`-related rows, replaced by:

| Failure | Handling | Resulting state |
|---|---|---|
| Duplicate submission, same `idempotencyKey`, operation `PROCESSING`, **lease still valid** | Concurrent in-flight request | `409` |
| Duplicate submission, same `idempotencyKey`, operation `PROCESSING`, **lease expired** (NEW, B3) | Reclaim: same `TurnOperation` row, `attemptCount += 1`, fresh `processingStartedAt`/`processingLeaseExpiresAt`, no duplicate `CandidateResponse`/create-flow rows, resume from persisted unadvanced `InterviewState`, single conditional `UPDATE ... WHERE status='PROCESSING' AND processingLeaseExpiresAt < now()` guards against a double-reclaim race | Operation moves back through `PROCESSING` → `SUCCEEDED`/`FAILED_RETRYABLE`/`FAILED_FINAL` |

All other rows (schema validation failure, transport error, version mismatch,
`SUCCEEDED`-replay, `FAILED_RETRYABLE`-resume, same-`questionId`-different-key rejection) are
**unchanged from v2**. Full state-machine detail and the conditional-update SQL shape:
`API_CONTRACT.md` v3 §5.

---

## 8. Evidence → Assessment → Final Assessment Aggregation Pipeline (amended — B1, B2, B6 terminology/algorithm pointer)

The pipeline shape from v2 is unchanged through step 4 (evidence/assessment persistence, gap
lifecycle, contradiction accumulation). At `CLOSING → COMPLETED`, steps are renumbered/amended:

```
1. RequirementAssessment.score (1–5), rubric-derived, contributes to Requirement Fit only.
2. CompetencyAssessment.score (1–5), same rubric applied independently, contributes to
   Competency Score only (C5 — unchanged, never blended with step 1).
3. CompetencyAssessment.rating derived from .score via scoring.config.ts thresholds (C7,
   unchanged). CompetencyAssessment carries NO gate fields (B1 — isCriticalGate/gateStatus
   removed entirely from this entity).
4. Gate evaluation (B1/B2, NARROWED): for every RequirementAssessment where the linked
   JobRequirement.criticalGate == true, compute gateStatus (CLEARED/FAILED/INSUFFICIENT_DATA).
   All other RequirementAssessment rows, and EVERY CompetencyAssessment row without exception,
   get gateStatus = NOT_A_GATE / no gate field at all, respectively. There is no competency-gate
   evaluation step anywhere in this pipeline.
5. competencyScore = weighted average across CompetencyAssessment rows only, using each row's
   .weight (API_CONTRACT.md v3 §2.6 — 1.0 default for dynamically generated position-specific
   competencies; scoring.config.ts value for universal competencies).
6. criticalGateStatus (RENAMED from mustHaveGateStatus, B2) aggregated across step-4 rows only:
   ALL_CLEARED / ONE_OR_MORE_FAILED / ONE_OR_MORE_INSUFFICIENT.
7. overallRecommendation computed by the deterministic algorithm in SCORING_FRAMEWORK.md v3 §8
   (B6): confidence-band ordering, top-down tier selection requiring ALL of a tier's conditions,
   material-input INSUFFICIENT_DATA capping, and the critical-gate INSUFFICIENT_DATA override.
   This document defers the algorithm's exact steps to SCORING_FRAMEWORK.md v3 to avoid a second
   copy that could drift.
8. keyStrengths / concerns / recommendationRationale / notes / rationale — deterministic
   templates (C8, unchanged).
9. contradictions assembled from per-turn contradiction_status (unchanged).
10. FinalAssessment assembled (API_CONTRACT.md v3 §2.9, including the new scoringConfigVersion
    field) and persisted once.
```

---

## 9–10. Resolved Inconsistencies Log / Formerly-Open Decisions (v3 additions)

| # | Inconsistency | Resolution |
|---|---|---|
| 15 | Competency-level gate fields duplicated/ambiguous relative to requirement gates | Removed entirely; only `JobRequirement.criticalGate` gates anything (B1/B2) |
| 16 | `PROCESSING` treated as a permanent latch with no crash-recovery path | Renewable/reclaimable lease with deterministic duration and a single conditional-update reclaim (B3) |
| 17 | `maxDurationMinutes` ambiguously measured against wall-clock time, vulnerable to idle-tab inflation | Split into Active Interview Time (clamped, accumulated) vs. Session Idle Time (separate inactivity guardrail) (B4) |
| 18 | Objective `SATISFIED` transition under-specified (risked being evidence-count-only) | Four-condition rule + `genuineAttempt` definition, feeding premature-completion protection and `unverifiedAreas` (B5) |
| 19 | `overallRecommendation` computation lacked an explicit, executable algorithm for confidence ordering, tier selection, and INSUFFICIENT_DATA handling | Deterministic algorithm specified in `SCORING_FRAMEWORK.md` v3 §8; this document points to it rather than duplicating (B6) |

No implementation-blocking decision remains in this document.

---

*End of INTERVIEW_STATE.md v3. See `API_CONTRACT.md` v3 for exact data shapes,
`SCORING_FRAMEWORK.md` v3 for the finalization algorithm, and `DOMAIN_GLOSSARY.md` for term
definitions.*
