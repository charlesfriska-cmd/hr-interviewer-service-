# API_CONTRACT.md
## Authoritative Node.js ⇄ HR Interviewer Agent Boundary — Data Contracts

Status: Authoritative technical contract, **v2**. Supersedes `API_CONTRACT.md` v1 (the
document previously indexed as `API_CONTRACT-1.md`). This revision closes implementation
blockers C1–C16 identified by Claude Code Plan Mode. Supersedes any conflicting type shape or
enum in `ARCHITECTURE.md`, `INTERVIEW_FRAMEWORK.md`, or `SCORING_FRAMEWORK.md` — those remain
authoritative for architecture/methodology; this document is authoritative for exact shapes and
boundaries.

Companion documents: `INTERVIEW_STATE.md` (state machine, lifecycle, guardrails, aggregation),
`SCORING_FRAMEWORK.md` (scoring methodology and `scoring.config.ts` shape),
`HR_INTERVIEWER_SYSTEM_PROMPT.md` v1.1 (the prompt producing the shapes defined here).

---

## 1. Field Authority Legend

| Tag | Meaning |
|---|---|
| **[NODE]** | Node.js writes/owns this field. The AI never sets it; a same-named AI field is ignored. |
| **[AI-REC]** | The AI recommends this value. Node.js validates before it is trusted, and may override or reject it. |
| **[DERIVED]** | Computed by Node.js from other persisted fields. Never directly written. |
| **[IMMUTABLE]** | Set once, never mutated after creation. |
| **[CONFIG]** | Sourced from `scoring.config.ts` or equivalent recruiter/job configuration, never from the AI and never hardcoded inline. |

---

## 2. Persistent Entities — Exact Shapes

### 2.1 `Interview`

```typescript
interface Interview {
  id: string;                          // [NODE][IMMUTABLE]
  candidateId: string;                 // [NODE][IMMUTABLE]
  positionId: string;                  // [NODE][IMMUTABLE]
  status: InterviewStatus;             // [NODE]
  createdAt: string;                   // [NODE][IMMUTABLE]
  updatedAt: string;                   // [DERIVED]
  startedAt?: string;                  // [NODE]
  completedAt?: string;                // [NODE]
  terminatedReason?: string;           // [NODE]
  maxDurationMinutes: number;          // [NODE][IMMUTABLE]
  maxQuestions: number;                // [NODE][IMMUTABLE]
  maxFollowUpsPerObjective: number;    // [NODE][IMMUTABLE]
}
```

Unchanged from v1. 100% Node.js-owned by design.

### 2.2 `InterviewState`

```typescript
interface InterviewState {
  interviewId: string;                              // [NODE][IMMUTABLE]
  currentPhase: InterviewStatus;                     // [NODE]
  currentObjectiveId: string | null;                 // [NODE]
  questionsAskedCount: number;                       // [DERIVED]
  followUpsByObjective: Record<string, number>;      // [DERIVED]
  phaseElapsedSeconds: Record<InterviewPhase, number>; // [DERIVED] — NEW (C15): tracks time spent per phase to compute soft-budget status
  unresolvedGapIds: string[];                        // [NODE] — references into the `evidence_gaps` table (Section 2.10), not free text
  lastQuestionId: string | null;                     // [NODE]
  version: number;                                   // [NODE][DERIVED]
  updatedAt: string;                                 // [DERIVED]
}
```

**Change (C15):** added `phaseElapsedSeconds` so Node.js can compute `phaseBudgetStatus`
(`ON_TRACK` | `OVER_BUDGET`) per phase and include it in `TurnRequest.constraints` as a soft
signal. This is informational only — see Section 5 and `INTERVIEW_STATE.md` §4/§4a for the
removal of hard `PHASE_CAP_REACHED` forcing.

The AI never receives or sets `version`.

### 2.3 `InterviewPlan` and `InterviewObjective` (C2 — objective identity lifecycle)

```typescript
interface InterviewPlan {
  interviewId: string;              // [NODE][IMMUTABLE]
  objectives: InterviewObjective[]; // [NODE] once persisted — see minting process below
  createdAt: string;                // [NODE][IMMUTABLE]
  version: number;                  // [NODE] (incremented only by recruiter override)
}

interface InterviewObjective {
  id: string;                       // [NODE][IMMUTABLE] — canonical UUID, minted by Node.js; never AI-supplied
  phase: InterviewPhase;            // [AI-REC], validated against the closed enum
  requirementIds: string[];         // [AI-REC], validated: every id must exist in the requirements sent to the AI
  competencyTag: string;            // [AI-REC], free-form label; registered into this interview's competency tag registry (§5.2 of v1, retained unchanged)
  targetEvidenceCount: number;      // [AI-REC], rules-engine clamped to 1–4
  status: "PENDING" | "IN_PROGRESS" | "SATISFIED" | "INSUFFICIENT_EVIDENCE"; // [NODE]
}
```

**Objective identity lifecycle (C2, canonical):**

1. The AI's `InitializationDecision.objectives[]` (Section 4.2) each carry a **response-local
   `ref`** such as `obj_1`, `obj_2` — a plain string unique only within that single response.
   `first_question.objective_ref` and any `operational_reasoning` text may reference these refs.
2. Node.js validates ref uniqueness within the response (Ajv-adjacent structural check, not
   schema-closed since refs are dynamic). A duplicate or malformed ref is a validation failure,
   handled via the standard retry-then-fallback path (`INTERVIEW_STATE.md` §6).
3. Node.js mints one canonical UUID per objective and builds an in-memory `ref → uuid` map for
   this initialization call only (never persisted, never sent back to the AI).
4. Node.js rewrites `first_question.objective_ref` and any other ref occurrences to the
   canonical UUID before persisting `InterviewPlan.objectives[].id` and the first `Question`.
5. From this point forward, every `TurnRequest.currentObjective.id` and every
   `TurnDecision.question.objective` the AI receives/emits is the **canonical Node-owned UUID**
   — the AI never mints, sees, or needs a `ref` again after initialization.

This fully replaces the v1 language ("AI's proposed identifier... retained only as an internal
debug label") with an explicit two-phase ref-then-mint protocol, since v1 left the mechanics of
*how* the AI could reference objectives within its own initialization response unspecified.

Once `InterviewPlan` is persisted, `objectives[].id/.phase/.requirementIds/.competencyTag/
.targetEvidenceCount` are read-only reference data for the interview's lifetime (mutable only
via a recruiter override, which creates a new plan `version`).

### 2.4 `JobRequirement` (C4 — critical gate is a distinct, Node-owned field)

```typescript
interface JobRequirement {
  id: string;                       // [NODE][IMMUTABLE]
  positionId: string;               // [NODE][IMMUTABLE]
  label: string;                    // [NODE][IMMUTABLE] (recruiter-authored)
  description: string;              // [NODE][IMMUTABLE] (recruiter-authored, untrusted downstream)
  priority: "MUST_HAVE" | "NICE_TO_HAVE"; // [NODE][IMMUTABLE] — a prioritization label ONLY
  competencyTag: string;            // [NODE][IMMUTABLE]
  recruiterWeight?: number;         // [NODE] human override, default 1.0
  criticalGate: boolean;            // [NODE][IMMUTABLE] — NEW (C4). Default false. Set ONLY by recruiter/job configuration at requirement-creation time. Never inferred, set, or overridden by the AI, and never derived from `priority`.
}
```

**Resolution (C4):** `MUST_HAVE` and `criticalGate` are independent. A requirement can be
`MUST_HAVE` and not a gate (common case — it must be evidenced, but weak performance is a
scoring penalty, not an automatic recommendation cap). A requirement can, in unusual cases, be
`NICE_TO_HAVE` and still `criticalGate: true` if the recruiting application explicitly
configures it that way (rare, but not disallowed — e.g., a legally required certification that
happens to be modeled as nice-to-have in the JD but is non-negotiable in practice). The AI is
never told which requirements are gates and has no field to express a gate opinion (enforced in
`HR_INTERVIEWER_SYSTEM_PROMPT.md` v1.1).

Competencies can also be flagged as critical gates — see `SCORING_FRAMEWORK.md` §5 for the
parallel `criticalGate` flag on position-specific competency configuration.

### 2.5 `RequirementAssessment` (C5, C7, C8 — scoring/notes are deterministic, no double count)

```typescript
interface RequirementAssessment {
  requirementId: string;                                        // [NODE][IMMUTABLE]
  interviewId: string;                                          // [NODE][IMMUTABLE]
  coverageLevel: "COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED"; // [AI-REC] per turn → [NODE] applies after validation
  score: number | null;                                         // [DERIVED] 1–5, computed ONLY at finalization, via the rubric in SCORING_FRAMEWORK.md §7.1; contributes to Requirement Fit ONLY, never re-mixed into the Competency Score (see §2.9)
  confidenceBand: ConfidenceBand;                                // [DERIVED]
  confidenceScore: number;                                       // [DERIVED] numeric midpoint, internal sort/storage key only
  evidenceIds: string[];                                        // [DERIVED]
  gapIds: string[];                                              // [DERIVED] — NEW (C11): references into `evidence_gaps` (Section 2.10) relevant to this requirement
  insufficientEvidenceFlag: boolean;                             // [NODE] forced true per the closing rule regardless of AI's coverage_level
  gateStatus: "NOT_A_GATE" | "CLEARED" | "FAILED" | "INSUFFICIENT_DATA"; // [DERIVED] — NEW (C4/C6): only meaningful when the linked JobRequirement.criticalGate == true; "NOT_A_GATE" otherwise
  notes: string;                                                // [DERIVED] — NEW (C8, changed from [AI-REC]): templated deterministically from evidence summaries, coverage, concerns, and resolved/unresolved gaps. No LLM pass generates this text.
}

type ConfidenceBand = "VERY_LOW" | "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH";
```

**Change from v1 (C8):** `notes` is now `[DERIVED]`, not `[AI-REC]`. Node.js assembles it from
already-validated, already-persisted evidence summaries (§7.1 template rules in
`SCORING_FRAMEWORK.md`) — no dedicated final-assessment LLM pass exists for this or any other
narrative field in the MVP.

### 2.6 `CompetencyAssessment` (C5, C7, C16)

```typescript
interface CompetencyAssessment {
  competencyTag: string;                                        // [NODE][IMMUTABLE]
  interviewId: string;                                          // [NODE][IMMUTABLE]
  coverageLevel: "COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED"; // [AI-REC] per turn — NEW (C16), mirrors RequirementAssessment
  rating: "STRONG" | "ADEQUATE" | "WEAK" | "INSUFFICIENT_EVIDENCE"; // [DERIVED] — CHANGED (C7): computed from `score` via a range threshold table in scoring.config.ts, not model-supplied and not exact-equality-derived
  score: number | null;                                         // [DERIVED] 1–5, finalization-only; null iff rating == INSUFFICIENT_EVIDENCE
  confidenceBand: ConfidenceBand;                                // [DERIVED]
  confidenceScore: number;                                       // [DERIVED]
  evidenceIds: string[];                                        // [DERIVED]
  gapIds: string[];                                              // [DERIVED] — NEW (C11)
  isCriticalGate: boolean;                                       // [CONFIG] — NEW (C4): set from job/recruiter configuration for this competency, independent of any requirement's gate flag
  gateStatus: "NOT_A_GATE" | "CLEARED" | "FAILED" | "INSUFFICIENT_DATA"; // [DERIVED] — NEW (C4)
  rationale: string;                                            // [DERIVED] — CHANGED from [AI-REC] (C8 principle applied here too): templated from evidence, consistent with RequirementAssessment.notes
}
```

**Change (C7):** `rating` derivation uses continuous range logic against
`scoring.config.ts`-defined thresholds (`SCORING_FRAMEWORK.md` §2a), e.g. `score >= 4.0 →
STRONG`, `score >= 3.0 → ADEQUATE`, `score < 3.0 → WEAK`, `score === null → INSUFFICIENT_EVIDENCE`
— never an exact-value switch statement, and the exact cutoffs live in config, not inline code.

**Change (C16):** added `coverageLevel`. Per-turn `assessment_updates` (Section 4.2) may update
a competency's `coverageLevel`/evidence/confidence-band rollup directly (when `requirement_id`
is `null`) or update both the requirement rollup and the related competency rollup (when
`requirement_id` is non-null) — see Section 4.2 rules.

### 2.7 `Evidence`

```typescript
interface Evidence {
  id: string;                        // [NODE][IMMUTABLE]
  interviewId: string;               // [NODE][IMMUTABLE]
  requirementId: string | null;      // [AI-REC], validated against the plan's known requirement ids
  competencyTag: string;             // [AI-REC], validated against the plan's known competency tags
  sourceResponseId: string;          // [NODE][IMMUTABLE]
  summary: string;                   // [AI-REC] — FACT-only claims; INFERENCE must be explicitly hedged
  strength: EvidenceStrength;        // [AI-REC]
  createdAt: string;                 // [NODE][IMMUTABLE]
}

type EvidenceStrength = "VERY_WEAK" | "WEAK" | "MODERATE" | "STRONG" | "VERY_STRONG" | "INSUFFICIENT";
```

Unchanged from v1 (the 6-value enum fix from v1 is retained and is now also reflected correctly
in the system prompt, closing the prompt/schema mismatch that C3 flagged).

### 2.8 `Question` / `CandidateResponse`

Unchanged from v1 — see prior revision. `Question.objectiveId` is always the canonical
Node-minted UUID (Section 2.3), never a `ref`.

### 2.9 `FinalAssessment` (C5, C6 — parallel Competency Score and Requirement Fit, no double count)

```typescript
interface FinalAssessment {
  interviewId: string;                                    // [NODE][IMMUTABLE]

  // ----- Competency Score (Universal + Position-Specific competencies ONLY) -----
  competencyScore: number | null;                          // [DERIVED] weighted 1–5 across CompetencyAssessment rows only (see SCORING_FRAMEWORK.md §5). Requirement-level scores are NEVER folded into this number.
  competencyConfidenceBand: ConfidenceBand;                // [DERIVED]
  competencyAssessments: CompetencyAssessment[];            // [DERIVED]

  // ----- Requirement Fit (separate, not blended into competencyScore) -----
  requirementAssessments: RequirementAssessment[];          // [DERIVED] full list; filter by joined JobRequirement.priority for "must-have fit" / "nice-to-have fit" views — no separate duplicate arrays are stored
  mustHaveGateStatus: "ALL_CLEARED" | "ONE_OR_MORE_FAILED" | "ONE_OR_MORE_INSUFFICIENT"; // [DERIVED] — computed across all rows where JobRequirement.criticalGate == true (NOT all MUST_HAVE rows — see C4)

  // ----- Combined recommendation -----
  overallRecommendation: OverallRecommendation;            // [DERIVED] — computed from competencyScore + mustHaveGateStatus + confidence per SCORING_FRAMEWORK.md §8; Requirement Fit and gate status can only cap/downgrade the recommendation derived from competencyScore, never add to it, and Nice-to-Have performance can never upgrade it (C6)
  overallConfidenceBand: ConfidenceBand;                   // [DERIVED]

  keyStrengths: string[];                                  // [DERIVED] — templated from top-scored, evidence-linked dimensions (competency and requirement)
  concerns: string[];                                      // [DERIVED] — templated; passes through the protected-characteristic denylist backstop before assembly
  unverifiedAreas: string[];                               // [DERIVED] — objectives ending INSUFFICIENT_EVIDENCE
  contradictions: Array<{ description: string; resolved: boolean }>; // [DERIVED] — aggregated from per-turn contradiction_status
  riskFlags: string[];                                     // [DERIVED] — populated only when a critical gate fails/is insufficient, or an unresolved contradiction touches a MUST_HAVE or gate item
  niceToHaveHighlights: string[];                          // [DERIVED] — NEW (C6): notable Nice-to-Have coverage, surfaced to recruiters as additional context; explicitly documented as NOT a factor in overallRecommendation
  recommendationRationale: string;                         // [DERIVED] — templated from competencyScore, gate status, and confidence band

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
  reason: string;                                            // [NODE]
}
```

**Resolution (C5):** the prior single "weighted average across everything" model is replaced
with two parallel, non-overlapping computations: a **Competency Score** (from
`CompetencyAssessment` rows only — Universal + Position-Specific dimensions, using versioned
weights) and a **Requirement Fit** (from `RequirementAssessment` rows, split conceptually into
Must-Have / Nice-to-Have / Critical Gate views by filtering on `JobRequirement.priority` and
`.criticalGate`). Neither feeds numerically into the other; `overallRecommendation` is derived
from `competencyScore` and then **capped, never boosted**, by gate/requirement-fit outcomes.
Full formula in `SCORING_FRAMEWORK.md` §5.

**Resolution (C6):** Nice-to-Have performance can only appear as `niceToHaveHighlights` —
informational, recruiter-visible, never a numeric or categorical input to
`overallRecommendation`. The prior "Nice-to-Have promotes CONSIDER → RECOMMENDED" behavior is
removed entirely; no automatic promotion rule of any kind exists for Nice-to-Have items.

### 2.10 `EvidenceGap` (C11 — new persistent entity)

```typescript
interface EvidenceGap {
  id: string;                        // [NODE][IMMUTABLE] — canonical, Node-minted
  interviewId: string;               // [NODE][IMMUTABLE]
  objectiveId: string;               // [NODE][IMMUTABLE] — canonical objective UUID (Section 2.3)
  gapType: EvidenceGapType;          // [AI-REC], validated against the closed enum
  description: string;               // [AI-REC], short factual sentence
  status: "OPEN" | "RESOLVED";       // [NODE] — derived from AI's status signal plus Node.js reconciliation (see below); the AI proposes, Node.js applies
  createdAt: string;                 // [NODE][IMMUTABLE]
  resolvedAt: string | null;         // [NODE]
}

type EvidenceGapType =
  | "CONTEXT" | "RESPONSIBILITY" | "PERSONAL_CONTRIBUTION" | "ACTION"
  | "RESULT" | "MEASURABLE_OUTCOME" | "TECHNICAL_DEPTH"
  | "DECISION_RATIONALE" | "CONTRADICTION" | "OTHER";
```

**Deduplication (C11, resolved — reject free-text-equality dedup):** a gap's identity key is
`(objectiveId, gapType)`, **not** normalized description text. On each turn's
`evidence_gap_updates` (Section 4.2):

- If the AI emits `status: "OPEN"` for a `(objective_ref, gap_type)` pair and no `OPEN` row
  already exists for that `(objectiveId, gapType)` on this interview, Node.js inserts a new
  `EvidenceGap` row.
- If an `OPEN` row already exists for that `(objectiveId, gapType)`, Node.js updates its
  `description` to the latest text (the gap is still open, description is refreshed, no
  duplicate row is created) — this is what makes free-text-equality dedup unnecessary.
- If the AI emits `status: "RESOLVED"` for a `(objectiveId, gapType)` pair, Node.js finds the
  matching `OPEN` row (if any) and sets `status = "RESOLVED"`, `resolvedAt = now()`. If no
  matching `OPEN` row exists, this is a no-op (logged, not an error) — the AI may believe
  something was resolved that Node.js never tracked as open, which is treated as harmless.
- `InterviewState.unresolvedGapIds` is simply the set of this interview's `EvidenceGap.id`
  where `status == "OPEN"` — recomputed on every turn write, not independently maintained.

This gives at most one `OPEN` gap per `(objective, gapType)` at any time, which is a stronger
and cheaper guarantee than text-similarity deduplication and requires no fuzzy matching.

---

## 3. LLM Request/Response Envelope — Exact Shapes

### 3.1 `LLMRequest`

```typescript
interface LLMRequest {
  mode: "initialization" | "turn";  // [NODE] — NEW (C1): explicit dispatch field so one prompt/agent serves both schemas unambiguously
  systemPrompt: string;              // [NODE][IMMUTABLE]
  userPayload: InitializationRequest | TurnRequest; // [NODE]
  maxOutputTokens: number;           // [NODE][CONFIG]
  temperature: number;               // [NODE][CONFIG]
  timeoutMs: number;                 // [NODE][CONFIG]
}
```

### 3.2 `LLMResponse`

```typescript
interface LLMResponse {
  raw: unknown;
  parsed: InitializationDecision | TurnDecision | null; // CHANGED (C1): union of the two decision shapes, discriminated by the request's `mode`
  validationErrors: string[];
  providerLatencyMs: number;
  promptVersion: string;             // e.g. "v1.1"
}
```

`LLMResponse` remains an internal Node.js orchestration type, never sent to any client.

---

## 4. AI Payload Contracts

### 4.1 Inbound

```typescript
interface InitializationRequest {
  interviewId: string;
  positionTitle: string;
  companyContext?: string;
  organizationalValues?: string;
  requirements: CompactRequirement[];   // note: does NOT include criticalGate (C4) — the AI is never told gate status
  candidateProfile: CandidateProfileSummary;
  constraints: DeterministicConstraints;
}

interface TurnRequest {
  interviewId: string;
  currentPhase: InterviewPhase;
  currentObjective: InterviewObjective | null; // .id is always the canonical UUID here
  relevantEvidence: EvidenceRef[];
  unresolvedGaps: EvidenceGapRef[];      // CHANGED (C11): structured, not free-text strings
  currentQuestion: { id: string; text: string };
  latestAnswer: string;                  // untrusted; truncated per ARCHITECTURE.md §22
  constraints: DeterministicConstraints; // now includes phaseBudgetStatus, see below
}

interface CompactRequirement {
  id: string;
  label: string;
  priority: "MUST_HAVE" | "NICE_TO_HAVE";
  competencyTag: string;
  // criticalGate intentionally omitted — Node.js/config-only concern (C4)
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

interface EvidenceGapRef {                // NEW (C11)
  gapType: EvidenceGapType;
  description: string;
}

interface DeterministicConstraints {
  questionsAskedCount: number;
  maxQuestions: number;
  followUpsUsedForObjective: number;
  maxFollowUpsPerObjective: number;
  remainingTimeMinutes: number;
  phaseBudgetStatus: "ON_TRACK" | "OVER_BUDGET"; // NEW (C15) — soft signal only, turn-mode only
}
```

### 4.2 Outbound — `InitializationDecision` (C1, C2 — new, replaces the initialization half of `AIDecision`)

```typescript
interface InitializationDecision {
  candidate_message: string;
  objectives: Array<{
    ref: string;                    // response-local, e.g. "obj_1" — see Section 2.3
    phase: InterviewPhase;
    requirement_ids: string[];
    competency_tag: string;
    target_evidence_count: number;
  }>;
  first_question: {
    objective_ref: string;          // must match one of objectives[].ref
    competency: string;
    question_type: string;
    text: string;
  };
  operational_reasoning: {
    objective: string;
    evidence_gap: string;
  };
}
```

### 4.3 Outbound — `TurnDecision` (C1, renamed from `AIDecision`; C5/C7/C8/C11/C15/C16 applied)

```typescript
interface TurnDecision {
  status: "in_progress" | "complete";
  recommended_action: "FOLLOW_UP" | "CLARIFY" | "DEEP_DIVE" | "MOVE_NEXT" | "COMPLETE_INTERVIEW";
  candidate_message: string;
  question: {
    phase: InterviewPhase;
    objective: string;              // canonical objective id (rules-engine checked against the registry, not schema-closed)
    competency: string;             // must match this interview's competency tag registry
    question_type: string;
    text: string;
  } | null;                         // null iff recommended_action == "COMPLETE_INTERVIEW"
  evidence_updates: Array<{
    requirement_id: string | null;
    competency: string;
    summary: string;
    strength: EvidenceStrength;
  }>;
  assessment_updates: Array<{
    requirement_id: string | null;  // null → competency rollup only (C16); non-null → updates BOTH the requirement rollup and the related competency rollup
    competency: string;
    coverage_level: "COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED";
    confidence_band: ConfidenceBand;
  }>;
  evidence_gap_updates: Array<{     // NEW (C11) — replaces free-text-only gap description
    objective_ref: string;          // canonical objective id in turn mode (not a v1-style local ref)
    gap_type: EvidenceGapType;
    description: string;
    status: "OPEN" | "RESOLVED";
  }>;
  operational_reasoning: {
    objective: string;
    evidence_gap: string;
  };
  contradiction_status: "NONE" | "RESOLVED" | "UNRESOLVED";
  progress: {
    objectives_completed: number;
    objectives_total: number;
  };
}
```

No numeric `score` field exists anywhere in `InitializationDecision` or `TurnDecision`, in
either direction. No gate-status field exists anywhere the AI writes. There is no dedicated
"final-assessment" LLM call anywhere in the system (see `INTERVIEW_STATE.md` §7 and the Score
Source decision below) — scoring and all narrative fields are deterministic Node.js operations.

---

## 5. Idempotency / Retry Operation Model (C10, C12, C13 — consolidated)

**Resolution:** a single generalized `turn_operations` table (and its `init_operations`
counterpart for `POST /interviews`) replaces the ad hoc "cache the response body" idempotency
description in v1. A dedicated separate `turn_results` table is **not** needed — the operation
record itself carries the successful response body when applicable, which is simpler and keeps
one write path per outcome instead of two tables that must stay consistent with each other.

```typescript
interface TurnOperation {
  id: string;                          // [NODE][IMMUTABLE]
  scope: "interview_create" | "interview_response"; // [NODE][IMMUTABLE]
  idempotencyKey: string;              // [NODE][IMMUTABLE] — client-supplied
  requestHash: string;                 // [NODE][IMMUTABLE] — hash of the normalized request body; a replayed key with a DIFFERENT hash is a client error (409/422, never silently reused)
  interviewId: string | null;          // [NODE] — null only before an `interview_create` operation successfully creates the interview
  questionId: string | null;           // [NODE] — set for `interview_response` scope
  status: "PROCESSING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_FINAL"; // [NODE]
  attemptCount: number;                // [NODE]
  responseStatus: number | null;       // [NODE] — HTTP status that was/will be returned
  responseBody: Record<string, unknown> | null; // [NODE] — populated only when status == SUCCEEDED; this is what a replay returns without re-invoking the LLM
  createdAt: string;                   // [NODE][IMMUTABLE]
  updatedAt: string;                   // [DERIVED]
  expiresAt: string;                   // [NODE][IMMUTABLE] — TTL (e.g. 24h), matches v1's idempotency TTL
}
```

**Composite uniqueness:** `(scope, interviewId, questionId, idempotencyKey)` for
`interview_response`; `(scope, idempotencyKey)` for `interview_create` (no `interviewId` exists
yet at first attempt).

**State machine per request:**

1. Client submits with `Idempotency-Key`. Node.js looks up an existing `TurnOperation` by the
   composite key.
2. **No existing row** → insert one with `status = PROCESSING`, `attemptCount = 1`. Proceed.
3. **Existing row, `status == SUCCEEDED`** → return `responseBody`/`responseStatus` directly.
   No LLM call. No state mutation. (This is the "safe replay" case, unchanged in spirit from
   v1, now backed by an explicit table instead of an implicit cache.)
4. **Existing row, `status == PROCESSING`** → a concurrent duplicate is in flight; return `409`
   (do not double-process).
5. **Existing row, `status == FAILED_RETRYABLE`** → this is a resumable retry. For
   `interview_response` scope: the candidate's `CandidateResponse` row is **already durable**
   (inserted before the first LLM attempt, per Section 6/§13 of `ARCHITECTURE.md`, unchanged) —
   Node.js does **not** insert a second `candidate_responses` row. It increments `attemptCount`,
   sets `status = PROCESSING`, and resumes exactly at the "call the LLM" step using the
   already-persisted `InterviewState` (which never advanced during the failed attempt). For
   `interview_create` scope: if `interviewId` is already set (the DB rows for
   candidate/position/requirements were persisted before the failed AI call), Node.js reuses
   those rows rather than re-inserting; if `interviewId` is still null, nothing was persisted
   yet and the full create flow runs fresh.
6. **Existing row, `status == FAILED_FINAL`** → terminal; return the same final error
   (`422`) without any further attempt. `interview_create` reaches `FAILED_FINAL` after 3 total
   attempts (unchanged cap from v1 §8/§9 resolution #2); `interview_response` reaches
   `FAILED_FINAL` only if the underlying interview itself is independently terminal
   (`TERMINATED`/`ERROR`) — otherwise a turn-level retryable failure stays `FAILED_RETRYABLE`
   indefinitely within its TTL, since the candidate should always be able to retry a stalled
   turn.

**On completion of an attempt:**
- Schema validation / provider failure exhausted (both retries used) → `status =
  FAILED_RETRYABLE` (or `FAILED_FINAL` if the create-flow attempt cap is reached). Candidate
  answer, if any, remains untouched and durable. `InterviewState` remains unadvanced.
- Validated `TurnDecision`/`InitializationDecision` successfully applied and committed →
  `status = SUCCEEDED`, `responseBody` set to the exact payload returned to the client.

This directly satisfies C10/C12/C13: candidate answers are never persisted twice (guaranteed by
the pre-existing durable-write-before-LLM-call ordering, now made explicit alongside the
operation table), a retryable failure is never permanently cached as if it succeeded, and a
retry is never treated as if the original request never existed (it resumes the same tracked
operation, incrementing `attemptCount`, not starting a parallel one).

---

## 6. REST API Contract

### `POST /interviews`
- **Request body:** unchanged from v1 (Section 6), except `requirements[]` entries now accept
  an optional `criticalGate?: boolean` field (defaults `false` if omitted) per C4.
- **Headers:** `Idempotency-Key` required. **NEW (C14):** service-to-service auth header (see
  Section 8) required; there is no candidate-facing auth on this endpoint at all — it is only
  ever called by the calling application backend, never directly by a candidate client.
- **Response 201:** unchanged shape.
- **Errors:** `400` invalid payload; `422` after the operation reaches `FAILED_FINAL`.
- **Retry semantics:** see Section 5 (`TurnOperation`, `scope: "interview_create"`), capped at 3
  total attempts, replacing the v1 ad hoc description with the formal state machine above.

### `POST /interviews/{interviewId}/responses`
- **Request body:** unchanged: `{ questionId, answer, idempotencyKey }`.
- **Headers:** service-to-service auth (Section 8). The calling application backend is
  responsible for confirming this request corresponds to the correct candidate/interview at its
  own layer; this service does not issue or validate a candidate-held token.
- **Response 200 / Errors:** unchanged shapes, now backed by the `TurnOperation` model
  (Section 5) rather than an implicit idempotency cache.
- **Never exposes:** `evidence_updates`, `assessment_updates`, `evidence_gap_updates`,
  `operational_reasoning`, `strength`, `coverage_level`, `confidence_band`, `contradiction_status`,
  gate status, or any scoring signal — unchanged from v1.

### `GET /interviews/{interviewId}`
Unchanged.

### `GET /interviews/{interviewId}/result`
- **Response 200:** full `FinalAssessment` (Section 2.9, expanded shape). `409` if not
  `COMPLETED`.
- **Auth (C14):** service-to-service; the calling application backend enforces recruiter/admin
  authorization at its own layer before proxying this call, or this service trusts a
  role claim asserted by the calling service (implementer's choice, documented in Section 8) —
  this service does not independently authenticate an individual recruiter.

### `GET /interviews/{interviewId}/transcript`
Unchanged from v1's resolution (one new recruiter-facing endpoint for MVP; plan-editing,
weight-override, and listing endpoints remain `DEFER_TO_POST_MVP`).

### `POST /interviews/{interviewId}/terminate`
Unchanged. No AI call, ever.

---

## 7. Schema Validation Boundaries

Unchanged in structure from v1, with these amendments:

| Boundary | Change |
|---|---|
| LLM → Node.js | Ajv now validates against **two** schemas selected by `mode`: `InitializationDecision` and `TurnDecision` (C1), each with the corrected 6-value `EvidenceStrength`, `confidence_band` enum, `contradiction_status`, and `evidence_gap_updates` array. |
| Ajv-valid decision → Rules Engine | Now additionally validates `evidence_gap_updates[].gap_type` against the closed `EvidenceGapType` enum and reconciles against existing `OPEN` gaps per the `(objectiveId, gapType)` dedup key (Section 2.10), not text similarity. |
| Ajv-valid decision → Protected-characteristic backstop | Unchanged: runs over `evidence_updates[].summary`, `operational_reasoning.*`, `evidence_gap_updates[].description`, and `candidate_message`. |
| Node.js → Candidate/Recruiter | Unchanged: hand-constructed allowlist DTOs. |

---

## 8. Authentication & Trust Boundary (C14 — replaces any candidate-token design)

**Resolution:** the candidate-bearer-token / `interview_access_tokens` architecture is rejected
for MVP. The intended deployment topology is:

```
Candidate → Client/Application (owned by the hiring company or its ATS vendor)
          → Application Backend  (the actual caller of this service)
          → HR Interviewer Service (this system)
```

The HR Interviewer Service is a **service-to-service backend**, never directly exposed to a
candidate's browser/app. Consequences:

- **Authentication principal:** the calling application/service, not the candidate and not the
  recruiter. A minimal service-to-service mechanism is sufficient for MVP — e.g. a signed
  service credential (API key or short-lived JWT issued to the calling backend), validated at
  the API layer before any request reaches the orchestrator. The exact mechanism (static API
  key vs. mTLS vs. service JWT) is an infrastructure choice left to the implementer; what is
  fixed is that it authenticates *a backend*, not *a person*.
- **`candidateId` and `interviewId` are business identifiers, not authentication principals.**
  They identify *which* interview a request concerns; they never grant access by themselves.
  The calling application backend is trusted to have already verified that the human on the
  other end of its own session is entitled to act on that `candidateId`/`interviewId` — this
  service does not re-derive that trust.
- **Recruiter/admin authorization** (`GET /result`, `POST /terminate`, `GET /transcript`) may
  remain entirely at the application layer (the calling backend decides who may call these
  endpoints and on whose behalf) unless a future requirement has this service exposed to
  multiple untrusted callers directly, at which point a role claim would need to travel in the
  service credential.
- **No candidate bearer tokens, no `interview_access_tokens` table, no candidate-facing login
  flow exist in this service for MVP.** If a future requirement introduces a direct
  candidate-to-service client (no application backend intermediary), that is a new,
  explicitly-scoped requirement — not an MVP default — and would need its own trust-boundary
  document before implementation.

This directly replaces `ARCHITECTURE.md` §23's "role separation between candidate and
recruiter/admin" language, which implied direct candidate authentication; that section should
be read as amended by this one.

---

## 9. Formerly-Open / Newly-Resolved Decisions — Index

| # | Item | Resolution location |
|---|---|---|
| C1 | Initialization AI contract | Section 4.2, `InitializationDecision` |
| C2 | Initialization objective references | Section 2.3 |
| C4 | Critical gates | Section 2.4, 2.5, 2.6 |
| C5 | Final scoring architecture | Section 2.9, `SCORING_FRAMEWORK.md` §5 |
| C6 | Nice-to-have promotion | Section 2.9 (`niceToHaveHighlights`) |
| C7 | Competency rating derivation | Section 2.6, `SCORING_FRAMEWORK.md` §2a |
| C8 | Requirement notes | Section 2.5 |
| C10/C12/C13 | Idempotency/retry model | Section 5 |
| C11 | Evidence gaps | Section 2.10, 4.1, 4.2 |
| C14 | Authentication | Section 8 |
| C15 | Phase limits | Section 2.2, 4.1 (`phaseBudgetStatus`); see `INTERVIEW_STATE.md` §4 for guardrail table change |
| C16 | Competency coverage | Section 2.6, 4.3 |

C3 (system prompt sync) and C9 (forced completion) are addressed in
`HR_INTERVIEWER_SYSTEM_PROMPT.md` v1.1 and `INTERVIEW_STATE.md` §2.2 respectively.

No implementation-blocking decision remains in this document.

---

*End of API_CONTRACT.md v2. See `INTERVIEW_STATE.md` for state machine and guardrail mechanics,
and `SCORING_FRAMEWORK.md` for the scoring configuration and aggregation pipeline.*
