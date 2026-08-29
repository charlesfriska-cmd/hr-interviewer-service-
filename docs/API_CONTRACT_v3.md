# API_CONTRACT.md
## Authoritative Node.js ⇄ HR Interviewer Agent Boundary — Data Contracts

Status: Authoritative technical contract, **v3**. Supersedes `API_CONTRACT.md` v2. Closes
implementation blockers B1, B2, B3, B4 (schema fields only — mechanics in `INTERVIEW_STATE.md`
v3), and B6 (schema fields only — algorithm in `SCORING_FRAMEWORK.md` v3). Sections not listed
below are **unchanged from v2** and remain authoritative as written there. See
`DOMAIN_GLOSSARY.md` for canonical term meanings referenced throughout.

---

## Amendment index

| Blocker | What changed here |
|---|---|
| B1 | `CompetencyAssessment.isCriticalGate` and `.gateStatus` removed. Competency weight sourcing clarified. |
| B2 | `FinalAssessment.mustHaveGateStatus` renamed `criticalGateStatus`. |
| B3 | `TurnOperation` gains lease fields (`processingStartedAt`, `processingLeaseExpiresAt`); `status` semantics amended. |
| B4 | `Interview` gains `maxCandidateResponseWindowSeconds`, `sessionIdleTimeoutMinutes`. `InterviewState` gains `elapsedActiveInterviewSeconds`, `lastActivityAt`. `Question` gains `presentedAt`. `CandidateResponse` gains `receivedAt`. |
| B6 | `FinalAssessment` gains `scoringConfigVersion`. `criticalGateStatus` value set clarified to include the `INSUFFICIENT_DATA`-driven override (algorithm in `SCORING_FRAMEWORK.md` v3 §8). |

---

## 2.1 `Interview` (amended — B4)

```typescript
interface Interview {
  id: string;                              // [NODE][IMMUTABLE]
  candidateId: string;                     // [NODE][IMMUTABLE]
  positionId: string;                      // [NODE][IMMUTABLE]
  status: InterviewStatus;                 // [NODE]
  createdAt: string;                       // [NODE][IMMUTABLE] — row creation, NOT interview start
  startedAt?: string;                      // [NODE] — CHANGED (B4): set exactly once, at the moment
                                            //   the first candidate-facing question becomes available
                                            //   (i.e., the PRE_INTERVIEW_ANALYSIS → OPENING transition
                                            //   commits). Never equal to createdAt if any planning
                                            //   delay occurred.
  updatedAt: string;                       // [DERIVED]
  completedAt?: string;                    // [NODE]
  terminatedReason?: string;               // [NODE] — now includes "SESSION_IDLE_EXPIRED" as a
                                            //   documented value (B4), distinct from
                                            //   "MAX_DURATION_EXCEEDED"/"MAX_QUESTIONS_EXCEEDED"/manual
  maxDurationMinutes: number;              // [NODE][IMMUTABLE] — CLARIFIED (B4): this bounds
                                            //   ACTIVE INTERVIEW TIME (elapsedActiveInterviewSeconds),
                                            //   never raw wall-clock time since createdAt/startedAt.
  maxQuestions: number;                    // [NODE][IMMUTABLE]
  maxFollowUpsPerObjective: number;        // [NODE][IMMUTABLE]
  maxCandidateResponseWindowSeconds: number; // [NODE][IMMUTABLE][CONFIG] — NEW (B4): per-turn clamp
                                            //   applied when computing turnActiveSeconds; prevents an
                                            //   abandoned/idle tab from consuming interview budget.
  sessionIdleTimeoutMinutes: number;       // [NODE][IMMUTABLE][CONFIG] — NEW (B4): inactivity window
                                            //   (measured from lastActivityAt) after which the
                                            //   pre-existing "candidate inactivity" guardrail
                                            //   (`INTERVIEW_STATE.md` §4) force-terminates the
                                            //   interview. Independent of maxDurationMinutes.
}
```

## 2.2 `InterviewState` (amended — B4)

```typescript
interface InterviewState {
  interviewId: string;                               // [NODE][IMMUTABLE]
  currentPhase: InterviewStatus;                      // [NODE]
  currentObjectiveId: string | null;                  // [NODE]
  questionsAskedCount: number;                        // [DERIVED]
  followUpsByObjective: Record<string, number>;       // [DERIVED]
  elapsedActiveInterviewSeconds: number;              // [DERIVED] — NEW (B4): the sum of every
                                                       //   turn's clamped turnActiveSeconds
                                                       //   (see INTERVIEW_STATE.md v3 §4b). This,
                                                       //   not (now() - startedAt), is what
                                                       //   maxDurationMinutes is checked against.
  phaseElapsedSeconds: Record<InterviewPhase, number>; // [DERIVED] — CLARIFIED (B4): each entry
                                                       //   accumulates ACTIVE seconds only (the same
                                                       //   clamped turnActiveSeconds, attributed to
                                                       //   whichever phase was current at that turn),
                                                       //   never wall-clock seconds.
  lastActivityAt: string;                             // [DERIVED] — NEW (B4): timestamp of the most
                                                       //   recent accepted candidate response or
                                                       //   system-initiated turn; used exclusively for
                                                       //   SESSION_IDLE_TIME / inactivity-timeout
                                                       //   evaluation, never for active-time math.
  unresolvedGapIds: string[];                         // [NODE] — references `EvidenceGap` rows
  lastQuestionId: string | null;                      // [NODE]
  version: number;                                    // [NODE][DERIVED]
  updatedAt: string;                                  // [DERIVED]
}
```

The AI never receives or sets `version`, `elapsedActiveInterviewSeconds`, or `lastActivityAt`
directly; it only ever sees the derived `DeterministicConstraints.remainingTimeMinutes` and
`phaseBudgetStatus` (unchanged from v2, now computed from active — not wall-clock — time).

## 2.3 `InterviewPlan` and `InterviewObjective` — unchanged from v2

`InterviewObjective.status` enum (`"PENDING" | "IN_PROGRESS" | "SATISFIED" |
"INSUFFICIENT_EVIDENCE"`) and the objective identity/ref-minting lifecycle are **unchanged in
shape**. The transition *rules* governing when Node.js moves a status between these four values
are refined in `INTERVIEW_STATE.md` v3 §5a (B5) — this is a mechanics change, not a schema
change, so this document's shape definition stands as originally written.

## 2.4 `JobRequirement` — unchanged from v2

`criticalGate: boolean` remains the **only** gate designation field in the entire system (B1)
— see Section 2.6 below for the corresponding removal on the competency side.

## 2.5 `RequirementAssessment` — unchanged from v2

Retains its own `gateStatus: "NOT_A_GATE" | "CLEARED" | "FAILED" | "INSUFFICIENT_DATA"`, still
meaningful only when the linked `JobRequirement.criticalGate == true` (unchanged rule, now the
system's *only* place gate status is computed at the requirement level — see B1/B2).

## 2.6 `CompetencyAssessment` (amended — B1: competency gates removed)

```typescript
interface CompetencyAssessment {
  competencyTag: string;                                        // [NODE][IMMUTABLE]
  interviewId: string;                                          // [NODE][IMMUTABLE]
  coverageLevel: "COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED"; // [AI-REC]
  rating: "STRONG" | "ADEQUATE" | "WEAK" | "INSUFFICIENT_EVIDENCE"; // [DERIVED] — threshold-derived (unchanged, C7)
  score: number | null;                                         // [DERIVED] 1–5, finalization-only
  confidenceBand: ConfidenceBand;                                // [DERIVED]
  confidenceScore: number;                                       // [DERIVED]
  evidenceIds: string[];                                        // [DERIVED]
  gapIds: string[];                                              // [DERIVED]
  weight: number;                                                // [CONFIG] — NEW, explicit (B1): the
                                                                  //   weight actually applied in
                                                                  //   `competencyScore` for this row.
                                                                  //   For a dynamically generated
                                                                  //   position-specific competency this
                                                                  //   is always `1.0` for MVP
                                                                  //   (recruiter-configurable weighting
                                                                  //   is DEFER_TO_POST_MVP). For a
                                                                  //   universal competency this is
                                                                  //   `scoring.config.ts`'s configured
                                                                  //   value, defaulting to `1.0`.
  rationale: string;                                            // [DERIVED] — templated (unchanged, C8)
}
```

**Removed (B1):** `isCriticalGate: boolean` and `gateStatus: ... ` are deleted from this
interface entirely. `CompetencyAssessment` can never be a gate in MVP; the only field name
`gateStatus` still exists on in the system is `RequirementAssessment.gateStatus` (Section 2.5)
and the finalization-level `FinalAssessment.criticalGateStatus` (Section 2.9). Any scoring or
validation logic that previously branched on `CompetencyAssessment.isCriticalGate` is removed —
see `SCORING_FRAMEWORK.md` v3 §6.

**Migration impact:** this is a field removal on a `[DERIVED]`/`[CONFIG]` set of columns computed
only at finalization; no historical `FinalAssessment` row needs backfilling since these fields
were never scored against real interview data pre-MVP-launch. If any pre-launch fixture data set
`isCriticalGate`/competency `gateStatus`, drop those columns/keys — no compensating migration is
needed.

## 2.7 `Evidence` — unchanged from v2

## 2.8 `Question` / `CandidateResponse` (amended — B4)

```typescript
interface Question {
  id: string;                        // [NODE][IMMUTABLE]
  interviewId: string;               // [NODE][IMMUTABLE]
  objectiveId: string;               // [NODE][IMMUTABLE] — canonical UUID (§2.3)
  phase: InterviewPhase;             // [NODE][IMMUTABLE]
  text: string;                      // [NODE][IMMUTABLE] — the validated AI-authored question text
  presentedAt: string;               // [NODE][IMMUTABLE] — NEW (B4): set the instant this question
                                      //   is persisted as the interview's current outstanding
                                      //   question (i.e., the instant it becomes candidate-facing).
                                      //   This is the "clock start" for turnActiveSeconds (§4b of
                                      //   INTERVIEW_STATE.md v3). For the very first question, this
                                      //   timestamp is also what Interview.startedAt is set from.
}

interface CandidateResponse {
  id: string;                        // [NODE][IMMUTABLE]
  questionId: string;                // [NODE][IMMUTABLE]
  interviewId: string;               // [NODE][IMMUTABLE]
  answerText: string;                // [NODE][IMMUTABLE] — untrusted, durable before any LLM call
  receivedAt: string;                // [NODE][IMMUTABLE] — NEW (B4): set the instant the answer is
                                      //   durably persisted (the pre-existing "durable before LLM
                                      //   call" write, C10/C12/C13 — unchanged ordering, timestamp
                                      //   now explicitly captured for active-time computation).
}
```

`Question.objectiveId` remains the canonical Node-minted UUID (unchanged, §2.3).

## 2.9 `FinalAssessment` (amended — B2, B6)

```typescript
interface FinalAssessment {
  interviewId: string;                                    // [NODE][IMMUTABLE]
  scoringConfigVersion: string;                            // [NODE][IMMUTABLE] — NEW (B6, promoted
                                                            //   from a v2 "should add" note to a
                                                            //   required field): the
                                                            //   SCORING_CONFIG_VERSION active when
                                                            //   this assessment was generated, so a
                                                            //   later recalibration never silently
                                                            //   reinterprets a historical result.

  // ----- Competency Score (Universal + Position-Specific competencies ONLY) -----
  competencyScore: number | null;                          // [DERIVED]
  competencyConfidenceBand: ConfidenceBand;                // [DERIVED]
  competencyAssessments: CompetencyAssessment[];            // [DERIVED] — no gate fields (B1)

  // ----- Requirement Fit -----
  requirementAssessments: RequirementAssessment[];          // [DERIVED]
  criticalGateStatus: "ALL_CLEARED" | "ONE_OR_MORE_FAILED" | "ONE_OR_MORE_INSUFFICIENT"; // [DERIVED]
                                                            // RENAMED from `mustHaveGateStatus` (B2).
                                                            // Computed EXCLUSIVELY across
                                                            // JobRequirement rows where
                                                            // `criticalGate == true`. Never implies
                                                            // anything about MUST_HAVE rows that are
                                                            // not configured gates. Since B1 removes
                                                            // competency-level gates, this field's
                                                            // input set is now, unambiguously,
                                                            // "configured critical-gate
                                                            // JobRequirements" and nothing else.

  // ----- Combined recommendation -----
  overallRecommendation: OverallRecommendation;            // [DERIVED] — algorithm in
                                                            //   SCORING_FRAMEWORK.md v3 §8 (B6)
  overallConfidenceBand: ConfidenceBand;                   // [DERIVED]

  keyStrengths: string[];                                  // [DERIVED]
  concerns: string[];                                      // [DERIVED]
  unverifiedAreas: string[];                                // [DERIVED]
  contradictions: Array<{ description: string; resolved: boolean }>; // [DERIVED]
  riskFlags: string[];                                     // [DERIVED] — now also populated when
                                                            //   `overallRecommendation` is forced to
                                                            //   `INSUFFICIENT_DATA` by the critical-gate
                                                            //   rule (B6), naming which gate(s) caused it
  niceToHaveHighlights: string[];                          // [DERIVED]
  recommendationRationale: string;                         // [DERIVED]

  generatedAt: string;                                     // [NODE][IMMUTABLE]
  humanOverride?: FinalAssessmentOverride;                 // [NODE]
}
```

**Rename (B2):** every reference to `mustHaveGateStatus` in any document, code comment, or
example is replaced by `criticalGateStatus`. The value semantics are unchanged — only the name
and the explicit clarification of its input set (critical-gate `JobRequirement` rows only) are
new.

**Migration impact:** a straight field rename plus one field addition
(`scoringConfigVersion`, already flagged as a planned addition in `SCORING_FRAMEWORK.md` v2 §9)
and one field removal set (competency gate fields, B1). No data transformation is required
beyond the rename/add/drop at the column or JSON-key level, since no production `FinalAssessment`
rows exist prior to MVP launch.

## 2.10 `EvidenceGap` — unchanged from v2

---

## 5. Idempotency / Retry Operation Model (amended — B3: PROCESSING is a renewable lease)

```typescript
interface TurnOperation {
  id: string;                          // [NODE][IMMUTABLE]
  scope: "interview_create" | "interview_response"; // [NODE][IMMUTABLE]
  idempotencyKey: string;              // [NODE][IMMUTABLE]
  requestHash: string;                 // [NODE][IMMUTABLE]
  interviewId: string | null;          // [NODE]
  questionId: string | null;           // [NODE]
  status: "PROCESSING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_FINAL"; // [NODE]
  attemptCount: number;                // [NODE]
  processingStartedAt: string | null;  // [NODE] — NEW (B3): set/refreshed every time `status`
                                        //   transitions INTO `PROCESSING` (first attempt or a
                                        //   lease-expired reclaim). Null when status is not
                                        //   `PROCESSING`.
  processingLeaseExpiresAt: string | null; // [NODE] — NEW (B3): `processingStartedAt +
                                        //   processingLeaseDurationSeconds` (deterministic
                                        //   application configuration, §5.1 below). Null when
                                        //   status is not `PROCESSING`. A `PROCESSING` row whose
                                        //   lease has expired is treated as abandoned/crashed and
                                        //   becomes reclaimable — see the state machine below.
  responseStatus: number | null;       // [NODE]
  responseBody: Record<string, unknown> | null; // [NODE]
  createdAt: string;                   // [NODE][IMMUTABLE]
  updatedAt: string;                   // [DERIVED]
  expiresAt: string;                   // [NODE][IMMUTABLE] — overall TTL, unchanged from v2, distinct
                                        //   from the much-shorter per-attempt processing lease
}
```

### 5.1 Lease configuration (NEW, B3)

`processingLeaseDurationSeconds` is a deterministic **application configuration** value (not
per-request, not instance-local memory) — e.g. a fixed constant sized comfortably above the
`LLMRequest.timeoutMs` plus adapter retry budget (`ARCHITECTURE.md` §17/§19–22), so that a lease
never expires while a request is still genuinely in flight under normal operation, but reliably
expires after a crashed/orphaned attempt. This value lives alongside other deployment
configuration (not inside `scoring.config.ts`, which is scoring-only) and is versioned the same
way as any other operational config — no new infrastructure component is introduced.

### 5.2 State machine per request (amended step 4, B3)

Steps 1–3 and 5–6 are **unchanged from v2**. Step 4 is replaced:

4. **Existing row, `status == PROCESSING`** — check the lease:
   - **`processingLeaseExpiresAt` is in the future (lease still valid):** a genuinely concurrent
     duplicate is in flight. Return `409`, exactly as v2 specified. No state change.
   - **`processingLeaseExpiresAt` has passed (lease expired — B3, NEW):** the prior attempt is
     presumed abandoned (crashed process, dropped connection, etc.) and the operation is
     **reclaimable**. The new request:
     - reuses the same `TurnOperation` row (same `id`, same idempotency key) — it never inserts a
       parallel row;
     - increments `attemptCount`;
     - sets `processingStartedAt = now()` and `processingLeaseExpiresAt = now() +
       processingLeaseDurationSeconds` (a fresh lease);
     - does **not** re-insert `CandidateResponse` (for `interview_response` scope) or re-create
       already-persisted candidate/position/requirement rows (for `interview_create` scope) — the
       existing durable-write-before-LLM-call ordering (unchanged from v2 §5) means the
       reclaiming attempt resumes safely from the already-persisted, unadvanced
       `InterviewState`;
     - proceeds with a fresh LLM call exactly as a `FAILED_RETRYABLE` resume would (step 5 of the
       original v2 state machine), the only difference being the operation was found in
       `PROCESSING` with an expired lease rather than explicitly marked `FAILED_RETRYABLE` by a
       prior attempt that had a chance to write that status before crashing.

**Concurrency/transaction note (B3):** claiming an expired lease must be done with a single
conditional update (`UPDATE turn_operations SET attemptCount = attemptCount + 1,
processingStartedAt = :now, processingLeaseExpiresAt = :newExpiry WHERE id = :id AND status =
'PROCESSING' AND processingLeaseExpiresAt < :now`), checking the affected-row count before
proceeding. If zero rows are affected, another concurrent request already reclaimed the lease
first (or the original attempt actually completed in the interim) — the losing request re-reads
the row and follows whichever branch now applies (`SUCCEEDED` → replay, still-valid `PROCESSING`
→ `409`, etc.), rather than proceeding under a false assumption that it holds the lease. This
requires no new table and no application-instance-local memory — the database row itself is the
only lock.

---

## 6. REST API Contract — unchanged from v2

No endpoint shapes change. `POST /interviews/{id}/responses` still never exposes `evidence_updates`,
gate status, or any scoring signal.

---

## 7–9. Schema Validation Boundaries / Authentication / Resolved-Decisions Index

Unchanged from v2 in structure. Section 9's index gains:

| # | Item | Resolution location |
|---|---|---|
| B1 | Competency gates removed | §2.6, `SCORING_FRAMEWORK.md` v3 §5–6 |
| B2 | Gate summary rename | §2.9 |
| B3 | Processing lease semantics | §5 |
| B4 | Active vs. idle time fields | §2.1, §2.2, §2.8 |
| B6 | Finalization determinism (schema side) | §2.9, `SCORING_FRAMEWORK.md` v3 §8 |

(B5 is a mechanics-only refinement with no schema change — see `INTERVIEW_STATE.md` v3 §5a.)

No implementation-blocking decision remains in this document.

---

*End of API_CONTRACT.md v3. See `INTERVIEW_STATE.md` v3 for state-machine/time/lease mechanics
and `SCORING_FRAMEWORK.md` v3 for the finalization algorithm. See `DOMAIN_GLOSSARY.md` for term
definitions.*
