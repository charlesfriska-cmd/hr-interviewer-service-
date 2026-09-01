# AMENDMENTS.md
## Implementation decisions taken beyond the authoritative specifications

Status: Living record, opened at the start of implementation against
`API_CONTRACT.md` v3 / `INTERVIEW_STATE.md` v3 / `SCORING_FRAMEWORK.md` v3 /
`DOMAIN_GLOSSARY.md` v1 / `ARCHITECTURE.md` v2 / `HR_INTERVIEWER_SYSTEM_PROMPT.md` v1.1.

Blockers C1–C16 and B1–B6 are all closed in the specifications; no
implementation-blocking contradiction remains. **A1, A2 and A5 are now APPLIED
and made canonical in `CONTRACT_ADDENDUM_v3.1.md`** — the sections below are
retained as the rationale record. The items below are decisions the
specifications leave open, or places where implementation revealed a detail worth
confirming. **Each is a proposed amendment awaiting sign-off, not an approved
deviation.** Where a decision is already implemented in code, the module is named.

---

## A1 — APPLIED (see CONTRACT_ADDENDUM_v3.1 §A1) — `Question` fields restored

**Observation.** `API_CONTRACT.md` v3 §2.8 restates both interfaces under the
heading "amended — B4" and marks only the two new fields (`presentedAt`,
`receivedAt`). Compared with v1/v2 the restatement omits `Question.sequenceNumber`,
`.competencyTag`, `.questionType`, `.askedAt`, and `CandidateResponse.idempotencyKey`,
`.rawText`/`.submittedAt`. The document's own convention is to mark deletions
explicitly (as §2.6 does for B1: "**Removed (B1):** … deleted from this interface
entirely"), and no such note appears here.

**Decision.** Treat the restatement as illustrative of the B4 change, not as a
field-removal list, and persist a superset:

- `sequenceNumber` retained — `UNIQUE (interview_id, sequence_number)` is the
  constraint that makes a double-applied turn impossible at the storage layer.
- `competencyTag`, `questionType` retained — the AI still emits both in
  `TurnDecision.question`; dropping them would silently discard audit fidelity.
- `idempotencyKey` **not** retained on `CandidateResponse` — `TurnOperation` owns
  idempotency as of C10/C12/C13, so its removal here reads as deliberate.
- `rawText` → `answerText` and `submittedAt` → `receivedAt` adopted as renames.

Implemented in `src/domain/types/entities.ts`. Extra persisted columns cannot
violate a contract the way a missing one can, so this is the safe direction — but
the `sequenceNumber` omission in particular looks unintentional and is worth
confirming.

---

## A2 — APPLIED (see CONTRACT_ADDENDUM_v3.1 §A2) — null competency score

**Observation.** `SCORING_FRAMEWORK.md` v3 §8.2 says that when `competencyScore`
is null, evaluation should "skip directly to §8.5". But §8.5's effect is
`tier = min(tier, "CONSIDER")`, and `tier` is never assigned because §8.2 was
skipped; §8.3's gate override is also bypassed by that jump. Taken literally the
branch has no defined output.

**Decision.** A null `competencyScore` means no competency ever reached adequate
evidence, which is precisely `DOMAIN_GLOSSARY`'s definition of `INSUFFICIENT_DATA`
("the interview process itself ended before enough material input could be
genuinely attempted — a process outcome, not a judgment on the candidate"). The
algorithm returns `INSUFFICIENT_DATA` and records a risk flag naming the cause.
The glossary governs meaning where prose conflicts, so this is derivable rather
than invented — but it should be written into §8.2 explicitly.

Implemented in `src/domain/scoring/recommendation.ts`; covered by
`test/unit/recommendation.test.ts`.

---

## A3 — `competencyLayer` discriminator added to `InterviewObjective`

**Observation.** `DOMAIN_GLOSSARY` defines `UNIVERSAL_COMPETENCY` and
`POSITION_SPECIFIC_COMPETENCY` as distinct kinds, and B1's weight sourcing
*depends* on the distinction: position-specific competencies are always weight
1.0, universal ones read `universalCompetencyWeights`. No field on any entity
records which kind a competency is.

Today the ambiguity is harmless because `universalCompetencyWeights` ships empty
and both paths resolve to 1.0. It becomes a correctness bug the moment anyone
tunes a universal weight: a dynamically generated position-specific competency
that happens to share a tag with a universal one (`communication` is a plausible
collision — the prompt lists it as universal and clustering could produce the same
label) would silently receive the universal weight, which §5.1 forbids.

**Decision.** Add `competencyLayer: "UNIVERSAL" | "POSITION_SPECIFIC"` to
`InterviewObjective` as an `[AI-REC]` closed enum validated at plan time, carried
onto `CompetencyAssessment`. This also supplies the Layer A / Layer B split that
`SCORING_FRAMEWORK.md` §12 and `INTERVIEW_FRAMEWORK.md` §19 need for the radar and
scorecard visualizations, which currently cannot separate the two.

Implemented in `src/domain/types/enums.ts`, `entities.ts`, and
`scoring/competencyTrack.ts`. **Requires a matching field in
`InitializationDecision.objectives[]` and a line in the system prompt — not yet
made, pending sign-off.**

---

## A4 — Values for configuration the specifications size but do not set

No specification supplies a number for these. Values chosen and their basis:

| Value | Chosen | Basis |
|---|---|---|
| `maxDurationMinutes` | 50 | `INTERVIEW_FRAMEWORK.md` §9 "Standard" preset (45–60 min) |
| `maxQuestions` | 24 | Standard preset against §4's phase targets |
| `maxFollowUpsPerObjective` | 2 | §11's "one, then at most a second" probing rule |
| `maxCandidateResponseWindowSeconds` | 600 | Generous for a considered answer, far below any plausible idle gap |
| `sessionIdleTimeoutMinutes` | 120 | Long enough to survive a genuine interruption, short enough to reclaim abandoned sessions |
| `processingLeaseDurationSeconds` | 480 | `API_CONTRACT.md` v3 §5.1's sizing rule: 60s timeout × 3 transport attempts × 2 schema attempts = 360s, plus 120s margin |

Implemented in `src/config/limits.config.ts`. All are calibration defaults, not
validated values.

---

## A5 — APPLIED (see CONTRACT_ADDENDUM_v3.1 §A5) — gaps are advisory; Node owns completion

**Observation.** `INTERVIEW_STATE.md` v3 §5a condition 4 requires that no
`EvidenceGap` for an objective remains `OPEN` before it can reach `SATISFIED`.
Gaps are opened and resolved solely by the AI's `evidence_gap_updates`. The system
prompt asks for "typically zero or one" gap per turn and permits a `RESOLVED`
status, but never requires the agent to close a gap it opened before recommending
`MOVE_NEXT`.

**Consequence if unaddressed.** An agent that opens a gap on turn 1, then obtains
strong evidence and moves on without explicitly resolving it, leaves the objective
permanently unable to reach `SATISFIED`. It closes as `INSUFFICIENT_EVIDENCE`
instead, which excludes it from the weighted average (§5.3), inflates
`unverifiedAreas`, and can cap the recommendation through §8.5. Objectives that
genuinely succeeded would be recorded as failures — systematically, not
occasionally.

**Proposed mitigation (not yet implemented).** Node.js deterministically resolves
any remaining `OPEN` gap for an objective at the moment that objective otherwise
meets conditions 1–3, auditing each auto-resolution. This keeps the AI's gap
signal advisory (consistent with every other AI recommendation) rather than
letting an omission silently invert an outcome. The alternative — a prompt
instruction to always close gaps before `MOVE_NEXT` — is weaker, because it makes
a scoring-critical outcome depend on model compliance.

**Resolved.** Gaps are now classified `BLOCKING` (`CONTRADICTION` only) or
`ADVISORY` by deterministic Node-owned rule. Condition 4 checks blocking gaps
only, and advisory gaps no longer supported by the latest structured assessment
are auto-resolved once conditions 1–3 hold, each with a mandatory
`GAP_AUTO_RESOLVED` audit event. A blocking gap is never auto-resolved unless its
own deterministic rule is satisfied. See `CONTRACT_ADDENDUM_v3.1.md` §A5.

---

## Carried forward — open, non-blocking, unchanged by v3

| # | Item | Note |
|---|---|---|
| O1 | Protected-characteristic denylist has no specified terms | Needs authoring as reviewable config by whoever owns fairness policy. Recommend redacting in evidence/reasoning/gap text but *substituting* the whole `candidate_message` on a match, so the candidate never sees a mangled sentence |
| O2 | Empty-phase handling | A phase can legitimately hold zero objectives (`INTERVIEW_FRAMEWORK.md` §5 forbids inventing a Values Alignment dimension with no values supplied). Recommend `MOVE_NEXT` advances to the next phase holding a non-`SATISFIED` objective, auditing each skip |
| O3 | Encryption at rest | `ARCHITECTURE.md` §23 requires it for CV and answer text; v3 §2.8 renames `rawText` → `answerText` with no encryption annotation. Recommend app-level AES-256-GCM at the persistence mappers |
| O4 | `ERROR` reachability | §6 routes every turn failure to `FAILED_RETRYABLE`, and §5 makes a response operation `FAILED_FINAL` only when the interview is *already* terminal — so in practice only the create flow can reach `ERROR`. Worth stating plainly |
| O5 | Rate limiting | `429` is in the contract with no shared store and stateless servers. Under C14 the only caller is a trusted backend, so per-candidate throttling belongs there; recommend a coarse DB-backed counter here as an abuse backstop |
| O6 | `Question.text` vs `candidate_message` overlap | Both carry the question. Recommend documenting `message` as the display surface and `question.text` as the record |
| O7 | `INTERVIEW_FRAMEWORK.md` is still v1 | Stale against v2/v3 in four places (§4 "or cap reached", §7 per-evidence `score`/`confidence`, §12 phase-cap forcing, §2/§8 "critical MUST_HAVE"). `DOMAIN_GLOSSARY` governs meaning, so nothing is blocked — but the methodology document now reads against the contracts |
| O8 | Turn operations have no attempt cap | Deliberate, so a candidate can always retry a stalled turn. Recommend an `attemptCount` threshold that raises the recruiter-visible flag rather than blocking |
| O9 | `CLOSING`-phase objectives are unreachable | `CLOSING → COMPLETED` always fires and `COMPLETE_INTERVIEW` forces `question: null`. Plan validation should reject or re-home them |

---

*Nothing in this document blocks implementation. Items A1–A5 are decisions already
acted on or, where marked, awaiting sign-off before the affected component is built.*

---

## Implementation notes added during the persistence / initialization stage

**Enum persistence strategy.** Closed sets are stored as `TEXT` with `CHECK`
constraints rather than native Postgres enum types. Adding a value to a native
enum is a DDL migration that cannot run in every transaction context, and the
sets are already enforced by Ajv and the domain layer; the `CHECK` is the
storage-layer backstop, not the primary gate.

**Objectives are relational, not JSONB.** `ARCHITECTURE.md` §10 sketched
`interview_plans.objectives` as JSONB. Questions, evidence and gaps all carry
foreign keys to an objective, and that is what preserves the §25 traceability
chain in the database rather than only in application code. `interview_plans`
remains as the version record.

**Two defects found and fixed while wiring the pipelines end to end:**

1. `PREMATURE_COMPLETION_BLOCKED` was evaluating *every* unresolved objective
   rather than MUST_HAVE-linked ones. An interview carrying only NICE_TO_HAVE
   work outstanding could never complete. Scoped via a new
   `PlanRepository.mustHaveObjectiveIds`.
2. `FinalizeInterviewService` read through the connection pool while being
   invoked from inside TX-B, so it could not see the evidence, assessments and
   gaps the same turn had just written. Every finalization read now runs in the
   caller's transaction.

**A5 auto-resolution needed a finalization sweep.** Per-turn auto-resolution only
reaches the objective being answered. An objective the interview has already
moved past can still carry an advisory gap the agent opened and never closed,
which would settle it as `INSUFFICIENT_EVIDENCE` and drop a genuinely successful
objective out of the weighted average. `FinalizeInterviewService` now sweeps
every objective before scoring, with no gap types re-asserted and
`contradictionStatus: NONE`, so a blocking gap is never cleared by the sweep.

**Idempotency precedes the stale-question check** in the turn pipeline.
`ARCHITECTURE.md` §13 lists question validation as step 2 and idempotency as step
3, but `INTERVIEW_STATE.md` §6 distinguishes the two cases by key: the same key on
an already-succeeded turn is a replay that must return the cached body, while a
different or absent key on a question that has moved on is a stale resubmit.
Checking staleness first makes a legitimate network retry impossible, since
`lastQuestionId` has advanced by then. A claim that then fails the stale check is
released so it cannot hold the key's lease.

---

## Provider integration findings

### P1 — `LLMRequest.temperature` is rejected by the current Claude model family

**Observation.** `API_CONTRACT.md` v3 §3.1 defines `LLMRequest.temperature` as a
`[NODE][CONFIG]` field, and `ARCHITECTURE.md` §17 recommends "temperature kept
low, e.g. 0.2–0.4, for consistency of judgment". That guidance predates the
current models: Claude Opus 5, Sonnet 5, Opus 4.7 and Opus 4.8 removed the
sampling parameters entirely and return **HTTP 400** if `temperature`, `top_p` or
`top_k` is sent. Sending the contracted value would fail every call.

**Handling.** This is provider translation, which `ARCHITECTURE.md` §17 assigns
to the adapter ("provider-specific adapters own all provider-specific
request/response translation"), so no contract change was improvised. The adapter
applies `temperature` only to models that still accept it and omits it otherwise;
`LLM_TEMPERATURE` remains configuration and is honoured wherever the provider
allows it. Determinism of *judgment* is instead served by `output_config.effort`,
which is the current control surface.

**Recommended contract amendment (not applied):** re-tag `LLMRequest.temperature`
as provider-optional and add `effort` alongside it, so the contract describes what
current providers actually accept. Deferred rather than improvised — it needs the
same sign-off as any other contract change.

### P2 — Confidence band is not sent on the turn payload

`TurnRequest` has never carried the rolling `confidence_band`; the agent emits one
per turn and Node.js stores it. The turn payload therefore sends
`currentConfidenceBand: null` with `currentCoverage` populated. If the agent
should see its own prior band, that is an additive contract change to
`TurnRequest`, not an adapter decision.

### Not a contradiction — structured output

`API_CONTRACT.md` §7's requirement that the provider's own structured-output
guarantee never be the trust boundary is preserved exactly: the canonical Ajv
schema is handed to the provider via `output_config.format` **and** every response
is independently re-validated by `validateDecision` before it leaves the adapter.
The schemas were not weakened to suit the provider.
