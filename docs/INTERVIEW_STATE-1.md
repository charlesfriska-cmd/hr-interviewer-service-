# INTERVIEW_STATE.md
## Authoritative State Machine, Lifecycle, Guardrails & Aggregation Contract

Status: Authoritative technical contract. Companion to `API_CONTRACT.md` (exact data shapes).
This document is authoritative for *how state moves and who is allowed to move it*.
It does not redesign the architecture or interview methodology in `ARCHITECTURE.md` /
`INTERVIEW_FRAMEWORK.md` / `SCORING_FRAMEWORK.md` — it consolidates and resolves the
Node.js ⇄ AI boundary those documents describe.

---

## 1. Scope Boundary (restated)

**Node.js decides what the system is allowed to do. The AI decides what is intelligent to do
within those boundaries.** Every mechanism in this document exists to make that governing rule
mechanically enforceable rather than aspirational — every AI recommendation is a *proposal*
that passes through schema validation, then a deterministic rules engine, before it can move
any state or reach any human.

---

## 2. Interview State Machine (authoritative)

### 2.1 States

```typescript
type InterviewStatus =
  | "INITIALIZING"
  | "PRE_INTERVIEW_ANALYSIS"
  | "OPENING"
  | "EXPERIENCE_VALIDATION"
  | "COMPETENCY_DEEP_DIVE"
  | "MOTIVATION_FIT"
  | "CLARIFICATION"
  | "CLOSING"
  | "COMPLETED"
  | "TERMINATED"
  | "ERROR";

// RESOLVED (API_CONTRACT.md §5.1): the subset of InterviewStatus that a question or
// objective can legitimately be attached to. Used for InterviewObjective.phase,
// TurnRequest.currentPhase, and AIDecision.question.phase.
type InterviewPhase = Exclude<InterviewStatus,
  "INITIALIZING" | "PRE_INTERVIEW_ANALYSIS" | "COMPLETED" | "TERMINATED" | "ERROR">;
// => "OPENING" | "EXPERIENCE_VALIDATION" | "COMPETENCY_DEEP_DIVE" | "MOTIVATION_FIT" | "CLARIFICATION" | "CLOSING"
```

Note: `INTERVIEW_FRAMEWORK.md` §4 documents "Phase 5 — Clarification & Closing" as a single
narrative phase for interview-methodology purposes. The state machine keeps `CLARIFICATION`
and `CLOSING` as two distinct `InterviewStatus` values because they have different transition
authority (AI-influenced vs. Node.js-only, see 2.2). This is a documentation-granularity
difference, not a contradiction — `InterviewPhase` includes both as separate values.

### 2.2 Transition Authority Table (authoritative)

| Transition | Trigger | Who moves it |
|---|---|---|
| `INITIALIZING → PRE_INTERVIEW_ANALYSIS` | Interview + inputs persisted | Node.js only, always fires |
| `PRE_INTERVIEW_ANALYSIS → OPENING` | Valid `InterviewPlan` received | AI produces the plan; Node.js applies it only after Ajv + rules-engine pass |
| `OPENING → EXPERIENCE_VALIDATION` | `MOVE_NEXT` recommended, or Node.js phase cap reached | AI recommends; Node.js decides, can force even without AI recommendation |
| `EXPERIENCE_VALIDATION → COMPETENCY_DEEP_DIVE` | same pattern | AI recommends; Node.js decides |
| `COMPETENCY_DEEP_DIVE → MOTIVATION_FIT` | same pattern | AI recommends; Node.js decides |
| `MOTIVATION_FIT → CLARIFICATION` | `CLARIFY`/`MOVE_NEXT` recommended, or unresolved-gap count > 0 at cap | AI recommends; Node.js decides |
| `CLARIFICATION → CLOSING` | `COMPLETE_INTERVIEW` recommended, or hard limit reached | Node.js has final authority regardless of AI |
| `CLOSING → COMPLETED` | Assessment aggregation finalized | Node.js only, always fires |
| `ANY (non-terminal) → TERMINATED` | Recruiter action, or candidate timeout | Node.js only — the AI has **zero** authority to terminate |
| `ANY (non-terminal) → ERROR` | Unrecoverable validation/provider failure after retries | Node.js only |

Within a phase, `FOLLOW_UP` / `CLARIFY` / `DEEP_DIVE` are intra-phase: they may change
`InterviewState.currentObjectiveId` but never `InterviewState.currentPhase`. Only `MOVE_NEXT`
and `COMPLETE_INTERVIEW` are phase-transition candidates, and even those are subject to the
guardrail overrides in Section 4.

---

## 3. `InterviewState` — Lifecycle & Field Ownership

Restated from `API_CONTRACT.md` §2.2 with lifecycle detail:

```typescript
interface InterviewState {
  interviewId: string;
  currentPhase: InterviewStatus;
  currentObjectiveId: string | null;
  questionsAskedCount: number;
  followUpsByObjective: Record<string, number>;
  unresolvedGapIds: string[];
  lastQuestionId: string | null;
  version: number;
  updatedAt: string;
}
```

**Write path (every turn, in order):**

1. Node.js loads `InterviewState` with its current `version`.
2. Node.js builds `TurnRequest` from `InterviewState` + relevant `Evidence` + `InterviewPlan`
   objective data — never from `AIDecision` of a prior turn (the LLM is stateless; every call
   is rebuilt from persisted truth, per `ARCHITECTURE.md` §2).
3. AI returns `AIDecision`; Node.js validates (Ajv → rules engine, `API_CONTRACT.md` §7).
4. Node.js computes the **final action** (Section 4) — which may differ from
   `recommended_action`.
5. Node.js writes the new `InterviewState` row with `WHERE version = :expected`. A mismatch
   aborts with `409` (Section 6, `ARCHITECTURE.md` §10/§20).

`unresolvedGapIds` is a Node.js-owned list of *references* (not full text), populated from the
validated `operational_reasoning.evidence_gap` and `assessment_updates` of each turn — the AI
never writes directly to this array; Node.js derives it from validated output. This closes a
latent ambiguity in `ARCHITECTURE.md` §9, which listed `unresolvedGapIds` as Node.js-owned but
did not specify the derivation source.

---

## 4. Guardrail Override Table (authoritative — the "Node.js overrides the AI" mechanics)

This is the concrete, implementable version of `ARCHITECTURE.md` §4's governing rule and §13's
guardrail examples, consolidated into one table so the rules engine has a single source of
truth.

| Condition (checked in this order) | Override applied | AuditEvent |
|---|---|---|
| `followUpsUsedForObjective >= maxFollowUpsPerObjective` AND `recommended_action` ∈ {`FOLLOW_UP`,`DEEP_DIVE`,`CLARIFY`} | Force `MOVE_NEXT` | `GUARDRAIL_OVERRIDE`, rule = `MAX_FOLLOWUPS_REACHED` |
| `questionsAskedCount >= maxQuestions` | Force `COMPLETE_INTERVIEW` regardless of `recommended_action` | `GUARDRAIL_OVERRIDE`, rule = `MAX_QUESTIONS_REACHED` |
| `remainingTimeMinutes <= 0` | Force `COMPLETE_INTERVIEW` regardless of `recommended_action` | `GUARDRAIL_OVERRIDE`, rule = `TIME_EXHAUSTED` |
| `question.competency` or `question.objective` not in this interview's registry (`API_CONTRACT.md` §5.2) | Treat as schema-adjacent failure → retry-once path (Section 6) | `VALIDATION_FAILURE` |
| `recommended_action == COMPLETE_INTERVIEW` but one or more MUST_HAVE objectives are still `PENDING`/`IN_PROGRESS` with follow-up budget remaining | Downgrade to `MOVE_NEXT` on the highest-priority unresolved MUST_HAVE objective instead of completing | `GUARDRAIL_OVERRIDE`, rule = `PREMATURE_COMPLETION_BLOCKED` |
| `evidence_updates[].strength == INSUFFICIENT` (or zero evidence) is the *only* evidence an objective has when it closes (`SATISFIED`/`INSUFFICIENT_EVIDENCE`) | Force `RequirementAssessment.insufficientEvidenceFlag = true`, irrespective of the AI's `coverage_level` | `GUARDRAIL_OVERRIDE`, rule = `INSUFFICIENT_EVIDENCE_FORCED` |
| Phase question-cap or phase time-cap reached (Node.js-configured, independent of overall caps) | Force `MOVE_NEXT` even if AI recommends staying (`FOLLOW_UP`/`DEEP_DIVE`/`CLARIFY`) | `GUARDRAIL_OVERRIDE`, rule = `PHASE_CAP_REACHED` |
| Candidate inactivity past configured timeout | Force `ANY → TERMINATED` | `STATE_TRANSITION`, actor = `SYSTEM_TIMEOUT` |
| `evidence_updates[].summary`, `operational_reasoning.*`, or `candidate_message` matches the protected-characteristic denylist (RESOLVED — formerly Open Question #5) | Redact the matched term in the stored copy; turn proceeds otherwise unmodified | `GUARDRAIL_OVERRIDE`, rule = `PROTECTED_CHARACTERISTIC_FILTERED` |
| AI-proposed `InterviewObjective.id` is missing, empty, or collides with another objective in the same plan (RESOLVED — formerly Open Question #6) | Node.js always assigns the canonical id (UUID) server-side; the AI's proposed id, if any, is never authoritative — this is not actually an "override" case since the AI's id was never trusted in the first place | N/A — no override event; this is normal plan-persistence behavior, not a guardrail correction |

**Rule ordering matters:** hard resource exhaustion (questions/time) always outranks
interview-quality concerns (premature completion blocking, phase caps). If both a resource cap
and a quality guardrail would fire on the same turn, the resource cap wins and is the one
recorded — a turn is never double-overridden with two competing reasons.

Every row in this table that changes the AI's `recommended_action` produces exactly one
`AuditEvent(type=GUARDRAIL_OVERRIDE)` naming which rule fired, the AI's original recommendation,
and the applied action — this is what makes "why did it move on / stop here" answerable purely
from audit data (`ARCHITECTURE.md` §25).

---

## 5. Context Optimization — What Is (and Isn't) Sent Per Turn

Restated from `ARCHITECTURE.md` §18, made explicit as a contract rather than a description:

| Layer | Contents | Sent to LLM on a turn? |
|---|---|---|
| Original raw data | Full CV text, full JD text | Never |
| Structured derived (once) | `CandidateProfileSummary`, `CompactRequirement[]` | Sent once, at `InitializationRequest` only |
| `InterviewPlan` | Full objective list | Never resent in full; referenced by `objectiveId` in `TurnRequest.currentObjective` (single object, not the array) |
| Rolling per-turn context | Current phase, current objective, **current-objective-only** evidence (`EvidenceRef[]`), current-objective-only unresolved gaps, current Q + latest A, `DeterministicConstraints` | Sent every turn — this is the entire per-turn payload |
| Historical archive | Full transcript, full cross-objective evidence history | Never sent to the turn loop; only read directly from DB for recruiter audit view or the final-assessment computation (Section 8) |

This bound is what keeps per-turn token cost flat regardless of interview length
(`ARCHITECTURE.md` §18) and is a hard contract, not a tuning suggestion — a context builder
that leaks prior-objective evidence into `relevantEvidence` violates this document.

---

## 6. Retry, Fallback & Concurrency (consolidated)

| Failure | Handling | Resulting state |
|---|---|---|
| Ajv schema validation fails | One retry with a corrective note appended to `userPayload`; on second failure → fallback | See below |
| Fallback (both attempts exhausted) | Deterministic "technical difficulty, please hold" `candidate_message` returned; `AuditEvent(type=VALIDATION_FAILURE)`; recruiter-visible flag raised | `InterviewState` **unchanged** — the turn did not consume a question slot or move state |
| LLM transport error/timeout | Adapter retries up to 2× with backoff; exhausted → same fallback path as above | `InterviewState` unchanged |
| `interview_state.version` mismatch on write | Abort, no retry server-side | `409` to client; client re-fetches and resubmits with the same `idempotencyKey` (safe — see below) |
| Duplicate submission, same `idempotencyKey` | Short-circuit at the idempotency check, before any LLM call | Cached prior result returned, no new state mutation, no duplicate AI call |
| Duplicate submission, same `questionId`, no/different `idempotencyKey` | Rejected — `lastQuestionId` will already have advanced | `409` |

**Why the candidate's answer always survives a downstream failure:** `CandidateResponse` is
committed in its own short transaction *before* the LLM is called (`ARCHITECTURE.md` §10/§13).
Every failure mode above therefore leaves the candidate's actual answer durable; only the
AI-derived state changes (evidence, assessments, `InterviewState`, next question) are at risk,
and those are exactly what the retry/fallback path re-attempts from a clean, unmutated
`InterviewState`.

---

## 7. Evidence → Assessment → Final Assessment Aggregation Pipeline

This section makes explicit the multi-stage pipeline implied but not fully specified across the
three source documents. All previously-open pieces are resolved — see Section 7.1/7.2 and the closure log in Section 9.

```
Per turn:                AIDecision.evidence_updates  ──► Evidence rows (persisted, [AI-REC] summary+strength)
                          AIDecision.assessment_updates ──► RequirementAssessment/CompetencyAssessment
                                                             .coverageLevel + .confidenceBand updated
                                                             (rolling, directional — NOT final)
                                                             .score stays null throughout the interview

At CLOSING → COMPLETED:  Node.js reads ALL persisted Evidence for this interview (not transcript)
                          ──► deterministic final-assessment computation (RESOLVED, formerly
                              Open Question #1 — no LLM call involved) produces:
                              - RequirementAssessment.score (1–5) — every MUST_HAVE/critical-gate item
                                must meet targetEvidenceCount or a genuine attempt, else excluded from
                                the weighted average and flagged INSUFFICIENT_DATA at that item's scope
                                (SCORING_FRAMEWORK.md §5)
                              - CompetencyAssessment.score (1–5)
                              - Critical-gate capping applied AFTER the weighted score (ceiling, not
                                an additive term)
                              - keyStrengths / concerns / recommendationRationale assembled by
                                template from stored evidence summaries + scores (Section 7.1)
                              - contradictions assembled from per-turn contradiction_status flags
                                (Section 7.2)
                              - FinalAssessment assembled (API_CONTRACT.md §2.9) and persisted once
```

### 7.1 Deterministic Scoring Rubric (RESOLVED — formerly Open Question #1)

No dedicated "final-assessment" LLM call exists anywhere in this system. Score is computed as
`f(highestEvidenceStrengthForDimension, finalCoverageLevel)` via a fixed lookup table:

| Highest evidence strength attained | `COVERED` | `PARTIALLY_COVERED` | `NOT_COVERED` |
|---|---|---|---|
| `VERY_STRONG` | 5 | 4 | 3 |
| `STRONG` | 4 | 3 | 2 |
| `MODERATE` | 3 | 2 | 2 |
| `WEAK` | 2 | 2 | 1 |
| `VERY_WEAK` | 1 | 1 | 1 |
| (only `INSUFFICIENT` evidence, or none) | `insufficientEvidenceFlag = true`, `score = null` (table not applied) |

This table is a simple, explainable, testable MVP default — deliberately blunt in favor of
auditability over sophistication, consistent with `SCORING_FRAMEWORK.md` §5's stated
preference. It is expressed as a Node.js config/data table (not hardcoded inline), so it can be
tuned without an architecture change. `confidenceBand` at finalization is simply the
`confidence_band` value already recorded by the most recent `assessment_updates` entry for that
dimension — no separate aggregation rule is needed since the rolling per-turn update already
keeps it current.

`keyStrengths`, `concerns`, and `recommendationRationale` are template-assembled by Node.js
from the scored, evidence-linked data above (e.g., top-N highest-score-and-confidence
dimensions → `keyStrengths`; MUST_HAVE dimensions scoring ≤2 or flagged
`insufficientEvidenceFlag` → `concerns`; a fixed sentence template combining `overallScore`,
`mustHaveGateStatus`, and `overallConfidenceBand` → `recommendationRationale`). No LLM call is
involved in producing this narrative text for the MVP. `concerns` text is passed through the
protected-characteristic denylist backstop (Section 4 guardrail table, rule
`PROTECTED_CHARACTERISTIC_FILTERED`) before assembly, same as every other evidence-sourced
string.

### 7.2 Contradiction Aggregation (RESOLVED — formerly Open Question #4)

`AIDecision` carries a per-turn `contradiction_status: "NONE" | "RESOLVED" | "UNRESOLVED"`
field (default `"NONE"`), populated by the AI per the existing methodology in
`INTERVIEW_FRAMEWORK.md` §15 (clarify first, then judge whether the clarification resolved the
discrepancy). At finalization, Node.js deterministically walks every turn's validated
`AIDecision` and appends one `FinalAssessment.contradictions` entry for every turn where
`contradiction_status != "NONE"`:

- `description` = that turn's `operational_reasoning.evidence_gap` (already required, already
  concise and factual — reused rather than inventing a new text field).
- `resolved` = `(contradiction_status == "RESOLVED")`.

This deliberately covers only the already-in-scope per-turn case. True cross-objective
contradiction reconciliation (comparing evidence from non-adjacent objectives) remains
MVP-deferred per `ARCHITECTURE.md` §18 — unaffected by this resolution.

**Critical-gate capping rule (deterministic, Node.js-enforced regardless of any AI proposal):**

- Any critical-gate dimension scoring 1–2 with adequate evidence → `overallRecommendation`
  capped at `CONSIDER`, gate failure surfaced in `riskFlags`.
- Any critical-gate dimension `INSUFFICIENT_EVIDENCE` → that gate's scope capped at
  `INSUFFICIENT_DATA`, never silently treated as passing.

**Minimum Evidence Threshold rule:** a MUST_HAVE requirement or critical-gate competency that
never reached its `targetEvidenceCount` and never had a genuine budget-respecting attempt is
excluded from the weighted average entirely — it does not silently average in as a low score,
and it does not get skipped without a trace (it appears in `unverifiedAreas`).

---

## 8. Resolved Inconsistencies Log

(Full technical detail in `API_CONTRACT.md` §5 — this is the index.)

| # | Inconsistency | Source documents in conflict | Resolution |
|---|---|---|---|
| 1 | `EvidenceStrength` 4-value vs. 6-value enum | `ARCHITECTURE.md` §9/§16 vs. `SCORING_FRAMEWORK.md` §1 / `HR_INTERVIEWER_SYSTEM_PROMPT.md` | Standardized on 6 values everywhere (`API_CONTRACT.md` §5.1) |
| 2 | `question.phase`/`TurnRequest.currentPhase` typed as full `InterviewStatus` | `ARCHITECTURE.md` §9 vs. narrowing already applied to `InterviewObjective.phase` | Introduced `InterviewPhase` narrowed type, applied consistently (`API_CONTRACT.md` §5.1, this doc §2.1) |
| 3 | No defined mechanism to validate AI-supplied competency tags against a known set | Gap across all three documents | Per-interview competency tag registry derived from the persisted plan (`API_CONTRACT.md` §5.2) |
| 4 | No numeric `score` field on `RequirementAssessment`/`CompetencyAssessment` despite a mandated 1–5 rubric | `ARCHITECTURE.md` §9 vs. `SCORING_FRAMEWORK.md` §2/§9 | Added `score: number \| null`, populated only at finalization, never per-turn (`API_CONTRACT.md` §5.3, this doc §7) |
| 5 | Confidence as raw `number` vs. mandated qualitative bands | `ARCHITECTURE.md` §9/§16 vs. `SCORING_FRAMEWORK.md` §4 | AI emits `ConfidenceBand` enum only; Node.js derives a numeric midpoint for internal sorting (`API_CONTRACT.md` §5.4) |
| 6 | Rich conceptual Evidence Model (FACT/INFERENCE/CONCERN/MISSING_EVIDENCE, many fields) vs. narrow persisted `Evidence`/`evidence_updates` shape | `INTERVIEW_FRAMEWORK.md` §7 vs. `ARCHITECTURE.md` §9/§16 | Confirmed intentional: richer typing folds into hedged `summary` text and `operational_reasoning.evidence_gap`; no new persisted fields (`API_CONTRACT.md` §5.5) |
| 7 | `FinalAssessment` shape (5 fields) and `overallRecommendation` enum values completely mismatched between documents | `ARCHITECTURE.md` §9 vs. `SCORING_FRAMEWORK.md` §7/§8/§9 | Adopted `SCORING_FRAMEWORK.md`'s fuller shape and enum naming as canonical (`API_CONTRACT.md` §5.6, §2.9) |
| 8 | "Clarification & Closing" described as one narrative phase in the framework doc but modeled as two states in the state machine | `INTERVIEW_FRAMEWORK.md` §4 vs. `ARCHITECTURE.md` §6/§7 | Not a real contradiction — documentation-granularity difference only; both `CLARIFICATION` and `CLOSING` remain distinct `InterviewStatus` values because their transition authority differs (this doc §2.1) |
| 9 | `unresolvedGapIds` ownership stated as Node.js-owned but derivation source unspecified | `ARCHITECTURE.md` §9/§14 | Derivation source made explicit: computed from validated per-turn output, never written directly by the AI (this doc §3) |

---

## 9. Formerly-Open Decisions — Now Closed

All six items previously logged here as open are resolved. None required reopening any
architectural or methodological decision in `ARCHITECTURE.md`, `INTERVIEW_FRAMEWORK.md`, or
`SCORING_FRAMEWORK.md` — each was closed as a narrow, additive addendum at the same level of
detail as the rest of this contract.

| # | Item | Final decision | Owner | MVP scope |
|---|---|---|---|---|
| 1 | Final-assessment scoring mechanism | Deterministic rubric (Section 7.1); no LLM call. Narrative fields (`keyStrengths`/`concerns`/`recommendationRationale`) template-assembled by Node.js. | Node.js | Full rubric in MVP |
| 2 | Init-failure retry endpoint | No new endpoint; `Idempotency-Key` replay against an `ERROR` interview re-attempts init, capped at 3 total attempts (`API_CONTRACT.md` §6) | Node.js | Full behavior in MVP |
| 3 | Recruiter-facing endpoints | One new endpoint, `GET /interviews/{id}/transcript` (`API_CONTRACT.md` §6) | Node.js | Transcript endpoint in MVP; plan-edit, weight-override, and list-interviews endpoints `DEFER_TO_POST_MVP` |
| 4 | `contradictions` scope | `contradiction_status` field on `AIDecision`, deterministic per-turn aggregation (Section 7.2) | Shared (AI flags, Node.js aggregates) | Per-turn scope in MVP; cross-objective reconciliation remains `DEFER_TO_POST_MVP` (unchanged from original architecture) |
| 5 | Protected-characteristic denylist backstop | Fixed keyword/regex scan at turn validation (Section 4 guardrail table; `API_CONTRACT.md` §7) | Node.js | Keyword scan in MVP; semantic/multilingual detection `DEFER_TO_POST_MVP` |
| 6 | Objective id collision handling | Node.js always assigns the canonical id server-side; AI's proposed id is never authoritative (`API_CONTRACT.md` §2.3) | Node.js | Full behavior in MVP |

No implementation-blocking decision remains in either `API_CONTRACT.md` or this document.

---

*End of INTERVIEW_STATE.md.*
