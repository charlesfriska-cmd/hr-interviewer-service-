# API_CONTRACT.md
## Authoritative Node.js ⇄ HR Interviewer Agent Boundary — Data Contracts

Status: Authoritative technical contract. Supersedes any conflicting type shape or enum
in `ARCHITECTURE.md`, `INTERVIEW_FRAMEWORK.md`, or `SCORING_FRAMEWORK.md` — those documents
remain authoritative for *architecture* and *methodology*; this document is authoritative
for *exact shapes and boundaries*. Where a conflict existed, it is resolved here and logged
in `INTERVIEW_STATE.md` Section 8.

Companion document: `INTERVIEW_STATE.md` (state machine, lifecycle, guardrails, aggregation).

This document does not redesign architecture or interview methodology. It only fixes the
exact contract at the seam Node.js and the LLM communicate across, and the exact REST
contract candidates/recruiters communicate across.

---

## 1. Field Authority Legend

Every field below is tagged with exactly one authority marker:

| Tag | Meaning |
|---|---|
| **[NODE]** | Node.js writes/owns this field. The AI never sets it; if the AI's raw output includes a same-named field, it is ignored. |
| **[AI-REC]** | The AI recommends this value. Node.js validates it against schema + rules engine before it is trusted, and may override or reject it. Never persisted or shown until it passes validation. |
| **[DERIVED]** | Computed by Node.js from other persisted fields. Never directly written by a request body or by the AI. |
| **[IMMUTABLE]** | Set once, never mutated after creation (edits create a new version/row instead of mutating history). |

---

## 2. Persistent Entities — Exact Shapes

### 2.1 `Interview`

```typescript
interface Interview {
  id: string;                          // [NODE][IMMUTABLE]
  candidateId: string;                 // [NODE][IMMUTABLE]
  positionId: string;                  // [NODE][IMMUTABLE]
  status: InterviewStatus;             // [NODE] — see INTERVIEW_STATE.md Section 2
  createdAt: string;                   // [NODE][IMMUTABLE]
  updatedAt: string;                   // [DERIVED]
  startedAt?: string;                  // [NODE]
  completedAt?: string;                // [NODE]
  terminatedReason?: string;           // [NODE]
  maxDurationMinutes: number;          // [NODE][IMMUTABLE] (set at creation, recruiter-configurable only via new interview)
  maxQuestions: number;                // [NODE][IMMUTABLE]
  maxFollowUpsPerObjective: number;    // [NODE][IMMUTABLE]
}
```

No field on `Interview` is ever AI-recommended. This entity is 100% Node.js-owned by design
(`ARCHITECTURE.md` Section 4).

### 2.2 `InterviewState`

```typescript
interface InterviewState {
  interviewId: string;                              // [NODE][IMMUTABLE]
  currentPhase: InterviewStatus;                     // [NODE] (AI recommends transition; Node.js decides — see INTERVIEW_STATE.md Section 3)
  currentObjectiveId: string | null;                 // [NODE] (AI may propose a pivot; Node.js applies it)
  questionsAskedCount: number;                       // [DERIVED] (incremented by Node.js on question persist)
  followUpsByObjective: Record<string, number>;      // [DERIVED]
  unresolvedGapIds: string[];                        // [NODE] (synced from validated AI evidence_gap output, not free-written by AI)
  lastQuestionId: string | null;                     // [NODE]
  version: number;                                   // [NODE][DERIVED] (optimistic concurrency, incremented every write)
  updatedAt: string;                                 // [DERIVED]
}
```

The AI never receives or sets `version`. It is a pure Node.js/DB concurrency mechanism and is
never included in any LLM request or response payload.

### 2.3 `InterviewPlan`

```typescript
interface InterviewPlan {
  interviewId: string;            // [NODE][IMMUTABLE]
  objectives: InterviewObjective[]; // [AI-REC] at creation → [NODE] once validated and persisted
  createdAt: string;               // [NODE][IMMUTABLE]
  version: number;                 // [NODE] (incremented only by recruiter override, never by the AI mid-interview)
}

interface InterviewObjective {
  id: string;                      // [NODE] — RESOLVED (formerly Open Question #6): Node.js always generates the canonical id (UUID) at persist time. The AI's proposed identifier, if any, is never trusted as authoritative and is retained only as an internal debug label — it is never the id referenced by Question/Evidence/assessments.
  phase: InterviewPhase;           // [AI-REC], validated against closed enum — see Section 5.1 (RESOLVED)
  requirementIds: string[];        // [AI-REC], validated: every id must exist in the requirements sent to the AI
  competencyTag: string;           // [AI-REC], free-form label, but must match a tag introduced during planning (Node.js maintains the registry of valid tags per interview — see Section 5.2)
  targetEvidenceCount: number;     // [AI-REC], rules-engine bounded (e.g., clamp to 1–4)
  status: "PENDING" | "IN_PROGRESS" | "SATISFIED" | "INSUFFICIENT_EVIDENCE"; // [NODE] — status transitions are Node.js-owned even though the AI's evidence/coverage output is the trigger signal
}
```

Once `InterviewPlan` is persisted (post-validation), `objectives[].id`, `.phase`, `.requirementIds`,
`.competencyTag`, and `.targetEvidenceCount` become **read-only reference data** for the rest of the
interview (`[IMMUTABLE]` except via a recruiter override, which creates a new plan `version`, never
a mutation of the existing one).

### 2.4 `RequirementAssessment` (RESOLVED — see Section 5.3)

```typescript
interface RequirementAssessment {
  requirementId: string;                                        // [NODE][IMMUTABLE]
  interviewId: string;                                          // [NODE][IMMUTABLE]
  coverageLevel: "COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED"; // [AI-REC] per turn → [NODE] applies after validation
  score: number | null;                                         // [DERIVED] 1–5, computed ONLY at final-assessment time; null until then (see INTERVIEW_STATE.md Section 6)
  confidenceBand: ConfidenceBand;                                // [DERIVED] — see Section 5.4
  confidenceScore: number;                                       // [DERIVED] numeric 0–1 midpoint of the band, for sorting/storage only, never shown as false precision
  evidenceIds: string[];                                        // [DERIVED] accumulated from validated evidence_updates
  insufficientEvidenceFlag: boolean;                             // [NODE] forced true whenever the closing rule in ARCHITECTURE.md §16 fires, regardless of AI's coverage_level
  notes: string;                                                 // [AI-REC] short, non-narrative (final-assessment pass only)
}

type ConfidenceBand = "VERY_LOW" | "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH";
```

### 2.5 `CompetencyAssessment` (RESOLVED — see Section 5.3)

```typescript
interface CompetencyAssessment {
  competencyTag: string;                                        // [NODE][IMMUTABLE]
  interviewId: string;                                          // [NODE][IMMUTABLE]
  rating: "STRONG" | "ADEQUATE" | "WEAK" | "INSUFFICIENT_EVIDENCE"; // [AI-REC] per turn qualitative signal
  score: number | null;                                         // [DERIVED] 1–5, computed only at final-assessment time; null if rating == INSUFFICIENT_EVIDENCE
  confidenceBand: ConfidenceBand;                                // [DERIVED]
  confidenceScore: number;                                       // [DERIVED]
  evidenceIds: string[];                                        // [DERIVED]
  rationale: string;                                            // [AI-REC] concise, evidence-referencing, never chain-of-thought
}
```

**Prior gap fixed:** `ARCHITECTURE.md` §9 defined neither entity with a numeric `score`, even
though `SCORING_FRAMEWORK.md` §2/§9 requires a 1–5 score per requirement and competency. Both
entities now carry `score`. Per-turn `AIDecision.assessment_updates` (Section 4.2) still never
carries a numeric score — see Section 5.3 for why and where the score is actually produced.

### 2.6 `Evidence`

```typescript
interface Evidence {
  id: string;                        // [NODE][IMMUTABLE]
  interviewId: string;               // [NODE][IMMUTABLE]
  requirementId: string | null;      // [AI-REC], validated against the plan's known requirement ids
  competencyTag: string;             // [AI-REC], validated against the plan's known competency tags
  sourceResponseId: string;          // [NODE][IMMUTABLE] (set by Node.js from the current turn's CandidateResponse, never trusted from AI output)
  summary: string;                   // [AI-REC] — FACT-only claims; any INFERENCE must be explicitly hedged in this text (see Section 5.5)
  strength: EvidenceStrength;        // [AI-REC], validated against closed enum — see Section 5.1 (RESOLVED)
  createdAt: string;                 // [NODE][IMMUTABLE]
}

type EvidenceStrength = "VERY_WEAK" | "WEAK" | "MODERATE" | "STRONG" | "VERY_STRONG" | "INSUFFICIENT";
```

**Prior contradiction fixed:** see Section 5.1.

### 2.7 `Question`

```typescript
interface Question {
  id: string;                 // [NODE][IMMUTABLE]
  interviewId: string;        // [NODE][IMMUTABLE]
  sequenceNumber: number;     // [DERIVED]
  phase: InterviewStatus;     // [NODE] — set to InterviewState.currentPhase at persist time, not taken verbatim from AI output
  objectiveId: string | null; // [AI-REC] proposed; [NODE] validated against the plan before persist
  competencyTag: string | null; // [AI-REC] proposed; [NODE] validated
  questionType: string;       // [AI-REC] free text descriptor (e.g. "behavioral_follow_up")
  text: string;                // [AI-REC] — this is `candidate_message`'s question content, see Section 4.2
  askedAt: string;             // [NODE][IMMUTABLE]
}
```

### 2.8 `CandidateResponse`

```typescript
interface CandidateResponse {
  id: string;                 // [NODE][IMMUTABLE]
  questionId: string;         // [NODE][IMMUTABLE]
  interviewId: string;        // [NODE][IMMUTABLE]
  rawText: string;             // candidate-submitted; [IMMUTABLE] once stored, always untrusted data downstream
  submittedAt: string;         // [NODE][IMMUTABLE]
  idempotencyKey: string;      // [NODE][IMMUTABLE], unique per (interviewId, questionId)
}
```

Entirely candidate-submitted / Node.js-persisted. The AI never writes to this entity; it only
reads `rawText` (truncated per Section 4.1) as `latestAnswer`.

### 2.9 `FinalAssessment` (RESOLVED — see Section 5.6, expanded shape)

```typescript
interface FinalAssessment {
  interviewId: string;                                    // [NODE][IMMUTABLE]
  overallRecommendation: OverallRecommendation;            // [DERIVED] — computed by Node.js aggregation rules (SCORING_FRAMEWORK.md §5/§8), optionally proposed by a dedicated final-assessment AI call but Node.js has final say, same governing rule as every other AI recommendation
  overallScore: number | null;                             // [DERIVED] weighted 1–5; null/omitted if any critical gate is INSUFFICIENT_DATA
  overallConfidenceBand: ConfidenceBand;                   // [DERIVED]
  requirementAssessments: RequirementAssessment[];          // [DERIVED] full list, includes both MUST_HAVE and NICE_TO_HAVE
  competencyAssessments: CompetencyAssessment[];            // [DERIVED]
  mustHaveGateStatus: "ALL_CLEARED" | "ONE_OR_MORE_FAILED" | "ONE_OR_MORE_INSUFFICIENT"; // [DERIVED]
  keyStrengths: string[];                                  // [DERIVED] — RESOLVED (formerly Open Q1): templated by Node.js from the top-scored requirement/competency evidence summaries; no dedicated LLM call exists
  concerns: string[];                                      // [DERIVED] — templated from evidence summaries flagged with low strength/coverage on MUST_HAVE items; passes through the protected-characteristic denylist backstop (Section 7, formerly Open Q5) before assembly
  unverifiedAreas: string[];                               // [DERIVED] — objectives ending INSUFFICIENT_EVIDENCE
  contradictions: Array<{ description: string; resolved: boolean }>; // [DERIVED] — RESOLVED (formerly Open Q4): aggregated from every turn where AIDecision.contradiction_status != "NONE"; description sourced from that turn's operational_reasoning.evidence_gap, resolved = (status == "RESOLVED")
  riskFlags: string[];                                     // [DERIVED] — populated deterministically whenever a critical gate fails or an unresolved contradiction touches a MUST_HAVE item; AI may not add risk flags outside this trigger
  recommendationRationale: string;                         // [DERIVED] — RESOLVED (formerly Open Q1): templated by Node.js from overallScore, gate status, and confidence band; not LLM-generated in the MVP
  generatedAt: string;                                     // [NODE][IMMUTABLE]
  humanOverride?: FinalAssessmentOverride;                 // [NODE]
}

type OverallRecommendation =
  | "STRONGLY_RECOMMENDED"
  | "RECOMMENDED"
  | "CONSIDER"
  | "NOT_RECOMMENDED"
  | "INSUFFICIENT_DATA";

interface FinalAssessmentOverride {
  reviewerId: string;                                       // [NODE][IMMUTABLE]
  overriddenAt: string;                                      // [NODE][IMMUTABLE]
  originalRecommendation: OverallRecommendation;             // [NODE][IMMUTABLE]
  newRecommendation: OverallRecommendation;                  // [NODE]
  reason: string;                                            // human-entered, [NODE]
}
```

**Prior contradiction fixed:** see Section 5.6.

---

## 3. LLM Request/Response Envelope — Exact Shapes

### 3.1 `LLMRequest` (transport envelope, provider-agnostic)

```typescript
interface LLMRequest {
  systemPrompt: string;    // [NODE][IMMUTABLE] — fixed, versioned; NEVER contains candidate/CV/JD text (see HR_INTERVIEWER_SYSTEM_PROMPT.md)
  userPayload: InitializationRequest | TurnRequest; // [NODE] — assembled fresh every call, see Section 4.1
  maxOutputTokens: number; // [NODE] config-driven, not hardcoded
  temperature: number;     // [NODE] config-driven, recommended 0.2–0.4
  timeoutMs: number;       // [NODE] config-driven
}
```

### 3.2 `LLMResponse` (the validated envelope Node.js works with internally — distinct from the raw provider payload)

```typescript
interface LLMResponse {
  raw: unknown;                 // exact bytes/JSON returned by the provider adapter, pre-validation, kept only in-memory for the retry/audit path — never persisted verbatim beyond the AuditEvent.payload snapshot
  parsed: AIDecision | null;    // null if schema validation failed on both attempts
  validationErrors: string[];   // Ajv error list, empty if parsed succeeded
  providerLatencyMs: number;    // [DERIVED]
  promptVersion: string;        // [NODE] — the versioned systemPrompt id used, for audit correlation
}
```

`LLMResponse` is an internal Node.js orchestration type — it is never sent to any client and
never crosses back to the LLM. It exists to make explicit that "what the provider returned"
and "what Node.js has validated and trusts" are two different objects, per `ARCHITECTURE.md`
§17 ("the provider's own guarantee is not trusted as the security/correctness boundary").

---

## 4. AI Payload Contracts (the actual per-call JSON shapes)

### 4.1 Inbound — `InitializationRequest` / `TurnRequest`

```typescript
interface InitializationRequest {
  interviewId: string;
  positionTitle: string;
  companyContext?: string;
  organizationalValues?: string;
  requirements: CompactRequirement[];
  candidateProfile: CandidateProfileSummary;
  constraints: DeterministicConstraints;
}

interface TurnRequest {
  interviewId: string;
  currentPhase: InterviewPhase;                 // RESOLVED narrowing, see Section 5.1
  currentObjective: InterviewObjective | null;
  relevantEvidence: EvidenceRef[];               // current/adjacent objective only, per ARCHITECTURE.md §18
  unresolvedGaps: string[];
  currentQuestion: { id: string; text: string };
  latestAnswer: string;                          // untrusted; truncated to a configured max character count before this point, full text stored separately (ARCHITECTURE.md §22)
  constraints: DeterministicConstraints;
}

interface CompactRequirement {
  id: string;
  label: string;
  priority: "MUST_HAVE" | "NICE_TO_HAVE";
  competencyTag: string;
}

interface CandidateProfileSummary {
  headline: string;
  yearsOfExperience: number | null;
  keySkills: string[];
  notableExperience: string[];
}

interface EvidenceRef {
  requirementId: string | null;
  competencyTag: string;
  summary: string;
  strength: EvidenceStrength;
}

interface DeterministicConstraints {
  questionsAskedCount: number;
  maxQuestions: number;
  followUpsUsedForObjective: number;
  maxFollowUpsPerObjective: number;
  remainingTimeMinutes: number;
}
```

Nothing in these shapes changed from `ARCHITECTURE.md` §9 except `currentPhase` is now typed
`InterviewPhase` (a narrowed subset), not the full `InterviewStatus` — see Section 5.1.

### 4.2 Outbound — `AIDecision` (raw, pre-validation shape the model must produce)

```typescript
interface AIDecision {
  status: "in_progress" | "complete";
  recommended_action: "FOLLOW_UP" | "CLARIFY" | "DEEP_DIVE" | "MOVE_NEXT" | "COMPLETE_INTERVIEW";
  candidate_message: string;
  question: {
    phase: InterviewPhase;              // RESOLVED narrowing, see Section 5.1
    objective: string;                  // must reference an objective id known to this interview (rules-engine checked, not schema-closed — ids are dynamic per plan)
    competency: string;                 // must reference a competency tag known to this interview
    question_type: string;
    text: string;
  } | null;                             // null iff recommended_action == "COMPLETE_INTERVIEW"
  evidence_updates: Array<{
    requirement_id: string | null;
    competency: string;
    summary: string;
    strength: EvidenceStrength;         // RESOLVED 6-value enum, see Section 5.1
  }>;
  assessment_updates: Array<{
    requirement_id: string | null;
    competency: string;
    coverage_level: "COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED";
    confidence_band: ConfidenceBand;    // RESOLVED: band, not a raw 0–1 number — see Section 5.4
  }>;
  operational_reasoning: {
    objective: string;
    evidence_gap: string;
  };
  contradiction_status: "NONE" | "RESOLVED" | "UNRESOLVED"; // RESOLVED (formerly Open Question #4) — default "NONE"; set per INTERVIEW_FRAMEWORK.md §15's existing clarify-then-judge methodology, no new methodology introduced
  progress: {
    objectives_completed: number;
    objectives_total: number;
  };
}
```

**Two changes from `ARCHITECTURE.md` §16 are load-bearing and must be reflected in the Ajv
schema and in `HR_INTERVIEWER_SYSTEM_PROMPT.md`'s output contract before implementation:**

1. `strength` now accepts 6 values, not 4 (Section 5.1).
2. `assessment_updates[].confidence` is renamed `confidence_band` and takes one of the 5
   `ConfidenceBand` string values, not a raw float (Section 5.4). Node.js maps the band to a
   numeric midpoint for storage; the AI never emits a manufactured decimal.

No numeric `score` field exists anywhere in `AIDecision`. Per-turn AI output only ever
recommends `coverage_level` + `confidence_band` + evidence. See Section 5.3 for why scoring
is deliberately excluded from the turn loop. There is no dedicated "final-assessment" LLM
call anywhere in the system — see Section 8.1 (formerly Open Question #1): scoring and
narrative-field generation are both deterministic Node.js operations.

---

## 5. Resolved Inconsistencies (Architecture ⇄ Framework ⇄ Scoring)

### 5.1 Evidence strength enum mismatch (contradiction — RESOLVED)

`ARCHITECTURE.md` §9/§16 constrained `EvidenceStrength` to 4 values
(`STRONG | MODERATE | WEAK | INSUFFICIENT`). `SCORING_FRAMEWORK.md` §1 and
`HR_INTERVIEWER_SYSTEM_PROMPT.md`'s methodology section both instruct a 5-point quality scale
(`VERY_WEAK | WEAK | MODERATE | STRONG | VERY_STRONG`) plus the separate `INSUFFICIENT` "no
data" state — 6 values total. As specified, the model would be instructed to output values the
Ajv schema would reject, causing spurious validation-failure retries and fallback messages on
a large fraction of real turns.

**Resolution:** `EvidenceStrength` is `"VERY_WEAK" | "WEAK" | "MODERATE" | "STRONG" | "VERY_STRONG" | "INSUFFICIENT"`
everywhere (schema, TypeScript, prompt). This is the version reflected throughout this
document. `ARCHITECTURE.md` §9/§16 should be amended to match.

Similarly, `question.phase` and `TurnRequest.currentPhase` were typed as the full
`InterviewStatus` union in `ARCHITECTURE.md` §9, which includes non-question-bearing states
(`INITIALIZING`, `PRE_INTERVIEW_ANALYSIS`, `COMPLETED`, `TERMINATED`, `ERROR`) that could never
legitimately appear there — matching the narrowing already applied to `InterviewObjective.phase`.

**Resolution:** introduce `InterviewPhase = Exclude<InterviewStatus, "INITIALIZING" | "PRE_INTERVIEW_ANALYSIS" | "COMPLETED" | "TERMINATED" | "ERROR">` and use it consistently for `InterviewObjective.phase`, `Question`'s phase-facing fields in AI I/O, `TurnRequest.currentPhase`, and `AIDecision.question.phase`. `Question.phase` (the persisted entity) keeps the full `InterviewStatus` type since Node.js sets it deterministically from `InterviewState.currentPhase`, which can technically be any active state.

### 5.2 Competency tag registry (undefined — RESOLVED for MVP)

Neither `ARCHITECTURE.md` nor `INTERVIEW_FRAMEWORK.md` specified how Node.js validates that an
AI-supplied `competency` string (in evidence, assessments, or questions) refers to a tag that
actually exists for this interview, versus a hallucinated or drifted label.

**Resolution:** at plan-validation time (`POST /interviews`), Node.js extracts the full set of
`competencyTag` values that appear across `InterviewPlan.objectives` and persists it as the
interview's competency registry (no new table needed — derivable from `interview_plans.objectives`
JSONB, cached in memory per request). Every subsequent AI-supplied `competency` value on a
turn is checked against this registry; an unknown tag is treated as a schema-adjacent
validation failure (same retry-once-then-fallback path as Ajv failures, per `ARCHITECTURE.md`
§21), not silently accepted or silently dropped.

### 5.3 Where does the 1–5 numeric score come from? (undefined — RESOLVED)

`SCORING_FRAMEWORK.md` §2 mandates a 1–5 score per requirement/competency, but `AIDecision`
(`ARCHITECTURE.md` §16) has no score field in `assessment_updates`, and no document specified
whether scoring happens per-turn or only at the end.

**Resolution:** scoring is **never** produced per-turn. Per-turn `assessment_updates` only ever
carry `coverage_level` + `confidence_band` — directional signals, not final judgments. The 1–5
`score` on `RequirementAssessment`/`CompetencyAssessment` is populated exactly once, during the
`CLOSING → COMPLETED` finalization step, by a dedicated final-assessment computation that reads
the accumulated `Evidence` rows (not raw transcript, per `ARCHITECTURE.md` §18) for that
requirement/competency. Whether that computation is itself a deterministic rubric run in
Node.js, or one additional bounded LLM call scoped only to already-extracted evidence, is
**resolved as deterministic Node.js logic, no LLM call** — see `INTERVIEW_STATE.md` §7.1 (formerly Open Question #1). The *turn
loop's* `AIDecision` contract is unaffected and does not grow a score field — this closes the
type-level gap without deciding the open implementation question.

### 5.4 Confidence: number vs. band (contradiction — RESOLVED)

`ARCHITECTURE.md` §9 typed `RequirementAssessment.confidence` as a raw `number` (0–1), and
`AIDecision.assessment_updates[].confidence` the same way. `SCORING_FRAMEWORK.md` §4 explicitly
warns against "manufactured decimal precision" and specifies 5 qualitative bands instead.

**Resolution:** the AI never emits a raw float. `AIDecision.assessment_updates[].confidence_band`
takes one of `ConfidenceBand`'s 5 values. Node.js deterministically maps each band to a fixed
representative midpoint for storage/sorting (`VERY_LOW→0.15, LOW→0.4, MODERATE→0.6, HIGH→0.775,
VERY_HIGH→0.925`, matching the ranges in `SCORING_FRAMEWORK.md` §4) and stores both
`confidenceBand` (recruiter/UI-facing) and `confidenceScore` (internal sort/aggregation key) on
every assessment entity. `FinalAssessment.overallConfidenceBand` follows the same pattern.

### 5.5 Evidence Model richness vs. persisted `Evidence` shape (gap — RESOLVED)

`INTERVIEW_FRAMEWORK.md` §7 describes a rich evidence record (FACT/INFERENCE/CONCERN/
MISSING_EVIDENCE typing, `candidate_contribution`, `outcome`, `contradictions`, `concerns` as
separate fields). The persisted `Evidence` entity (`ARCHITECTURE.md` §9) and the
`AIDecision.evidence_updates` schema only carry `summary` + `strength`.

**Resolution (already implied, now made explicit):** this is intentional compression, not an
omission to fix by adding columns. FACT content goes into `summary` verbatim-in-substance;
INFERENCE content, if included, must appear in `summary` with an explicit hedge (e.g., prefaced
"Likely...", "Inferred:..."); CONCERN and MISSING_EVIDENCE content that is *not* itself a piece
of evidence goes into `operational_reasoning.evidence_gap`, not into `evidence_updates` at all.
No new structured fields are added to `Evidence` for the MVP — `HR_INTERVIEWER_SYSTEM_PROMPT.md`
already instructs this framing; this section just confirms the persisted schema is intentionally
narrower than the conceptual Evidence Model, by design (auditability priority favors a small,
stable schema over a wide one prone to inconsistent population).

### 5.6 `FinalAssessment` shape mismatch (contradiction — RESOLVED)

`ARCHITECTURE.md` §9's `FinalAssessment` interface has 5 fields. `SCORING_FRAMEWORK.md` §7's
methodology and §9's worked example require materially more: `overallScoreNote`/`overallScore`,
a top-level `confidence`, `mustHaveFit`/`niceToHaveFit` as distinct arrays, `keyStrengths`,
`concerns`, `unverifiedAreas`, `contradictions`, `riskFlags`, `recommendationRationale`.
Additionally, the two documents use **entirely different enum values** for the overall
recommendation: `ARCHITECTURE.md` used `STRONG_YES | YES | BORDERLINE | NO | INSUFFICIENT_DATA`;
`SCORING_FRAMEWORK.md` used `STRONGLY_RECOMMENDED | RECOMMENDED | CONSIDER | NOT_RECOMMENDED |
INSUFFICIENT_DATA`.

**Resolution:** `FinalAssessment` is expanded to the full shape in Section 2.9, matching
`SCORING_FRAMEWORK.md`'s methodology (the more complete and recruiter-facing of the two
sources). The enum is standardized on `SCORING_FRAMEWORK.md`'s naming
(`STRONGLY_RECOMMENDED | RECOMMENDED | CONSIDER | NOT_RECOMMENDED | INSUFFICIENT_DATA`) since it
is descriptive rather than binary-coded and already has a worked example and grading rubric
built around it (`SCORING_FRAMEWORK.md` §8). `mustHaveFit`/`niceToHaveFit` are not modeled as
separate arrays in the persisted type — they are the same `RequirementAssessment[]`, filterable
by the requirement's `priority` (already available by joining to `JobRequirement`), avoiding
duplicate storage of the same rows under two different array names.

---

## 6. REST API Contract

### `POST /interviews`
- **Request body:**
  ```typescript
  {
    candidate: Omit<Candidate, "id" | "cvStructuredSummary" | "createdAt">;
    position: Omit<Position, "id" | "createdAt">;
    requirements: Array<Omit<JobRequirement, "id" | "positionId">>;
    maxDurationMinutes?: number;
    maxQuestions?: number;
    maxFollowUpsPerObjective?: number;
  }
  ```
- **Headers:** `Idempotency-Key` required.
- **Response 201:**
  ```typescript
  { interviewId: string; status: "OPENING"; question: { id: string; text: string } }
  ```
- **Errors:** `400` invalid payload (schema/size-limit failure, checked before any AI call);
  `422` AI failed to produce a valid `InterviewPlan` after retry (interview persisted in
  `ERROR`).
- **Retry semantics (RESOLVED — formerly Open Question #2):** no dedicated retry endpoint
  exists. A replay of `POST /interviews` with the same `Idempotency-Key` against an interview
  currently in `ERROR` status re-runs the create-flow steps that touch the AI (using the
  already-persisted `candidates`/`positions`/`job_requirements` rows — no re-entry of data),
  instead of returning the cached `422`. This is capped at **3 total attempts per
  `Idempotency-Key`**; the 4th and subsequent replays return the cached `422` permanently. Each
  attempt (success or failure) writes its own `AuditEvent`.
- **Never exposes:** raw CV text, raw JD text (request echo omits these on response).

### `POST /interviews/{interviewId}/responses`
- **Request body:** `{ questionId: string; answer: string; idempotencyKey: string }`
- **Response 200:**
  ```typescript
  {
    status: "in_progress" | "complete";
    message: string;              // == validated AIDecision.candidate_message
    question?: { id: string; text: string }; // present iff status == "in_progress"
  }
  ```
- **Errors:** `404` interview/question not found; `409` interview terminal, stale `questionId`,
  or `version` conflict; `422` malformed AI response after retry (fallback message returned,
  `200` with a generic `message`, not an error — per `ARCHITECTURE.md` §22 fail-soft policy);
  `429` rate limit.
- **Never exposes:** `evidence_updates`, `assessment_updates`, `operational_reasoning`, `strength`,
  `coverage_level`, `confidence_band`, or any scoring signal. The candidate-facing surface is
  `message` and `question.text` only — nothing else from `AIDecision` crosses the API boundary
  to the candidate client.

### `GET /interviews/{interviewId}`
- **Response 200:** `{ interview: Pick<Interview, "id"|"status"|"createdAt"|"startedAt">; progress: { phase: InterviewStatus; questionsAsked: number; questionsRemaining: number } }`
- Never echoes raw CV/JD. No AI call.

### `GET /interviews/{interviewId}/result`
- **Auth:** recruiter/admin only.
- **Response 200:** full `FinalAssessment` (Section 2.9). `409` if `status != COMPLETED`.
- No AI call — read of persisted, already-finalized data.

### `GET /interviews/{interviewId}/transcript` (RESOLVED — formerly Open Question #3)
- **Auth:** recruiter/admin only.
- **Response 200:** ordered array of `{ question: Question; response: CandidateResponse | null; evidence: Evidence[] }`, joined by `interviewId`, available at any point in the interview's lifecycle (mid-interview or completed).
- **Errors:** `404` interview not found.
- **DB:** read-only, no AI call.
- **Scope note:** this is the only new recruiter-facing endpoint added for MVP. Plan-editing,
  `job_requirements.recruiter_weight` override, and interview-listing endpoints are
  **`DEFER_TO_POST_MVP`** — no stated MVP use case depends on them yet, and adding them now
  would be premature surface area per the governing principles.

### `POST /interviews/{interviewId}/terminate`
- **Auth:** recruiter/admin only.
- **Request:** `{ reason: string; actorId: string }`
- **Response 200:** `{ interviewId: string; status: "TERMINATED" }`
- No AI call, ever, under any circumstance (`ARCHITECTURE.md` §6/§11).

---

## 7. Schema Validation Boundaries

| Boundary | Validator | Enforcement point | Trust model |
|---|---|---|---|
| Candidate/recruiter → Node.js (REST request bodies) | JSON Schema / Zod (implementer's choice, not mandated) | API layer, before any DB write or AI call | Full validation; reject on any violation, no partial acceptance |
| Node.js → LLM (`LLMRequest.userPayload`) | None needed — Node.js constructs this from already-validated persisted data; it is production, not consumption | N/A | N/A |
| LLM → Node.js (`AIDecision`) | Ajv JSON Schema, matching Section 4.2 exactly (including the 6-value `EvidenceStrength` and `ConfidenceBand` fixes) | Immediately on provider response, before any business logic runs (`Validator` component in `ARCHITECTURE.md` §3 diagram) | **Never trust provider-native structured-output guarantees alone** — Ajv re-validates independently even if the provider's own schema mode was used |
| Ajv-valid `AIDecision` → Rules Engine | Deterministic rules engine (Section 5.2 tag registry check, plus all guardrails in `ARCHITECTURE.md` §13) | After Ajv, before persistence | Schema-valid ≠ trusted-to-apply; rules engine can still override or reject a schema-valid recommendation |
| Ajv-valid `AIDecision` → Protected-characteristic backstop (RESOLVED — formerly Open Question #5) | Fixed keyword/regex denylist (English, MVP scope) | Runs once per turn, over `evidence_updates[].summary`, `operational_reasoning.*`, and `candidate_message`, immediately after Ajv and alongside the rules engine | Never rely on prompt instruction alone (`ARCHITECTURE.md` §17 principle applied to a safety property, not just JSON shape); on a match, the term is redacted and `AuditEvent(type=GUARDRAIL_OVERRIDE, rule=PROTECTED_CHARACTERISTIC_FILTERED)` is logged — the turn is not failed. Semantic/multi-language detection is `DEFER_TO_POST_MVP`. |
| Node.js → Candidate/Recruiter (REST responses) | Response DTOs are hand-constructed allowlists (Section 6), never a pass-through serialization of internal entities | API layer, on the way out | Prevents accidental leakage of `operational_reasoning`, `strength`, `confidence_band`, etc. even if a future internal refactor adds fields to an entity |

**Governing rule, restated for this boundary document specifically:** an object is safe to
persist or show only after it has passed *both* Ajv schema validation *and* the deterministic
rules engine. Passing one without the other is never sufficient.

---

## 8. Formerly-Open Decisions — Now Resolved

All six items previously logged as open in `INTERVIEW_STATE.md` §9 are resolved and reflected
inline above. Index:

| # | Item | Resolution location |
|---|---|---|
| 1 | Final-assessment scoring mechanism | Section 2.9 (`score`, `keyStrengths`, `concerns`, `recommendationRationale` tags); full rubric in `INTERVIEW_STATE.md` §7 |
| 2 | Init-failure retry endpoint | Section 6, `POST /interviews` |
| 3 | Recruiter-facing endpoints | Section 6, `GET /interviews/{id}/transcript` |
| 4 | `contradictions` scope | Section 4.2 (`contradiction_status`), Section 2.9 |
| 5 | Protected-characteristic backstop | Section 7 (validation boundary table) |
| 6 | Objective id collision handling | Section 2.3 |

No implementation-blocking decision remains in this document. See `INTERVIEW_STATE.md` for the
corresponding state-machine-side detail and the deterministic scoring rubric.

---

*End of API_CONTRACT.md. See `INTERVIEW_STATE.md` for state machine, guardrail override
mechanics, and the final-assessment aggregation pipeline.*
