# DOMAIN_GLOSSARY.md
## Canonical Term Definitions — HR Interviewer System

Status: Authoritative glossary, **v1**. Introduced alongside `API_CONTRACT.md` v3,
`INTERVIEW_STATE.md` v3, and `SCORING_FRAMEWORK.md` v3 to close blockers B1–B6. Where any other
document's prose conflicts with a definition here, this document governs the *meaning* of the
term; the other documents govern exact field shapes.

---

### MUST_HAVE
A **priority label** on a `JobRequirement`, set by the recruiter/job configuration. It tells the
interview planner and reporting layer how much interview time and reporting weight a
requirement deserves. **It is not a hiring gate and does not by itself cap or block any
recommendation.** A requirement can be `MUST_HAVE` and never configured as a `CRITICAL_GATE`.

### NICE_TO_HAVE
The other `JobRequirement.priority` value. Lower planning priority. Its coverage is reported
(`niceToHaveHighlights`) but never enters `overallRecommendation` computation in any direction —
it cannot promote a recommendation, and (unless also flagged `criticalGate: true`, which is rare
but permitted) it cannot cap one either.

### CRITICAL_GATE
An independent boolean (`JobRequirement.criticalGate`) set only by recruiter/job configuration,
never inferred from `priority` and never set, suggested, or visible to the AI. A gate is a hard
pass/fail ceiling on `overallRecommendation`. **As of B1, gates exist only on `JobRequirement`
rows.** There is no competency-level gate concept in MVP.

### JOB_REQUIREMENT
A recruiter-authored, immutable statement of what the position needs (`JobRequirement` entity).
Carries `priority` (MUST_HAVE/NICE_TO_HAVE), `competencyTag`, and `criticalGate`. Distinct from a
`COMPETENCY`: a requirement is a specific, recruiter-stated need; a competency is a broader
behavioral/skill dimension the interview assesses, which one or more requirements may map to.

### COMPETENCY
A behavioral or skill dimension scored independently of any single requirement
(`CompetencyAssessment` entity). Two kinds: `UNIVERSAL_COMPETENCY` and
`POSITION_SPECIFIC_COMPETENCY`. Competencies drive `competencyScore`, the primary recommendation
signal. **Competencies are never gates (B1)** — only `JobRequirement.criticalGate` can gate.

### UNIVERSAL_COMPETENCY
A competency dimension applicable across most roles (Communication, Problem Solving,
Collaboration, Ownership, Adaptability, Motivation, Organizational/Values Alignment). Selected
per-role by the AI during planning; weight sourced from versioned application configuration
(`scoring.config.ts`), defaulting to `1.0` unless a role-specific override is configured.

### POSITION_SPECIFIC_COMPETENCY
A competency dimension generated dynamically by the AI during initialization by clustering the
position's actual `JobRequirement`s/JD text (roughly 3–6 per position). **For MVP, every
dynamically generated position-specific competency defaults to weight `1.0`.**
Recruiter-configurable weighting of position-specific competencies, and any pre-authored
position competency registry, are **`DEFER_TO_POST_MVP`** (B1) — MVP does not require or support
either.

### INTERVIEW_OBJECTIVE
A planning unit (`InterviewObjective` entity) grouping one competency or one tightly related
requirement cluster, assigned a canonical Node-minted `id`, a `phase`, and a `status`. See the
**Objective Status Lifecycle** below for its canonical state machine (B5).

### EVIDENCE
A discrete unit of candidate-answer-derived information (`Evidence` entity), tagged with a
`requirementId` and/or `competencyTag`, an `EVIDENCE_STRENGTH`, and a FACT-only `summary`
(inferences are hedged separately, never merged into `summary`).

### EVIDENCE_STRENGTH
The AI's per-evidence-item qualitative judgment of how strong that single piece of evidence is:
`VERY_WEAK | WEAK | MODERATE | STRONG | VERY_STRONG | INSUFFICIENT`. `INSUFFICIENT` means no
usable evidence was obtained at all — it is not the bottom of the quality scale, it is a
different kind of state (see `INSUFFICIENT_EVIDENCE` below).

### COVERAGE_LEVEL
The AI's per-turn rollup judgment of how completely an objective/requirement/competency has been
addressed so far: `COVERED | PARTIALLY_COVERED | NOT_COVERED`. Distinct from `EVIDENCE_STRENGTH`
(which grades one item) and from a numeric `score` (which Node.js computes only at
finalization).

### CONFIDENCE_BAND
A qualitative reliability signal on an assessment: `VERY_LOW | LOW | MODERATE | HIGH |
VERY_HIGH`. **Canonical total order (B6):**

```
VERY_LOW < LOW < MODERATE < HIGH < VERY_HIGH
```

This ordering is what tier-selection and gate logic compare against; it is never treated as an
unordered enum. Each band also has a numeric midpoint (`scoring.config.ts`) used only as an
internal sort/storage key, never surfaced as a fake-precise decimal to a person.

### EVIDENCE_GAP
A structured, persisted record (`EvidenceGap` entity) of a specific missing element for a
specific objective, keyed on `(objectiveId, gapType)`. Distinct from `INSUFFICIENT_EVIDENCE`: a
gap describes *what* is missing; `INSUFFICIENT_EVIDENCE` describes the *terminal outcome* when
that gap was never closed.

### INSUFFICIENT_EVIDENCE
An **objective/requirement/competency-level terminal state**: the interview did reach this item
(a genuine attempt occurred — see `genuineAttempt`, B5) but the evidence gathered never met the
bar for `SATISFIED`/scoring. It is deliberately distinct from a **low score** — absence of
evidence never lowers a numeric score, it produces this flag instead
(`RequirementAssessment.insufficientEvidenceFlag`, `CompetencyAssessment.rating ==
INSUFFICIENT_EVIDENCE`, `InterviewObjective.status == INSUFFICIENT_EVIDENCE`).

### INSUFFICIENT_DATA
A **finalization/reporting-level state**, one level up from `INSUFFICIENT_EVIDENCE`, applied to:
- `gateStatus` on a critical-gate requirement, when that requirement's evidence never reached a
  genuine, scoreable attempt at all, and
- `overallRecommendation`, when the interview process itself ended before enough material input
  could be genuinely attempted (a **process outcome**, not a judgment on the candidate).

Rule of thumb: `INSUFFICIENT_EVIDENCE` describes one item; `INSUFFICIENT_DATA` describes the
consequence of that (or an unattempted gate) for gating/finalization purposes. Every
`INSUFFICIENT_DATA` gate/finalization state traces back to one or more items being
`INSUFFICIENT_EVIDENCE` or never reached at all.

### ACTIVE_INTERVIEW_TIME
The clock the system actually enforces (`maxDurationMinutes`, phase soft budgets). Accumulates
only while a question is genuinely outstanding and being answered, clamped per-turn at
`maxCandidateResponseWindowSeconds` so an abandoned/idle tab cannot silently consume the
candidate's interview time budget. See `INTERVIEW_STATE.md` v3 §4b for full derivation. **Never**
equal to raw wall-clock time since interview creation.

### SESSION_IDLE_TIME
A **separate** concept from `ACTIVE_INTERVIEW_TIME`: how long since `lastActivityAt`, used only
to decide whether the whole session should be force-terminated for inactivity
(`SESSION_IDLE_EXPIRED`). Idle time is never added to `elapsedActiveInterviewSeconds` and never
consumes phase or interview budget — it can only end the interview outright via the existing
`ANY → TERMINATED` (inactivity) transition.

---

### Commonly confused pairs — quick reference

| A | B | Distinction |
|---|---|---|
| MUST_HAVE | CRITICAL_GATE | Priority label (time/reporting weight) vs. independent hard pass/fail ceiling. Orthogonal fields. |
| EVIDENCE_STRENGTH | COVERAGE_LEVEL | Per-item quality vs. per-objective/requirement/competency completeness rollup. |
| INSUFFICIENT_EVIDENCE | INSUFFICIENT_DATA | Item-level terminal evidence state vs. its finalization/gate-level consequence. |
| INSUFFICIENT_EVIDENCE | low score (1–2) | Absence of evidence vs. demonstrated weak performance. Never conflated; absence never lowers a score. |
| ACTIVE_INTERVIEW_TIME | SESSION_IDLE_TIME | Clamped, accumulated candidate-answering time vs. unclamped wall-clock inactivity gap. |
| UNIVERSAL_COMPETENCY | POSITION_SPECIFIC_COMPETENCY | Fixed, role-filtered set vs. dynamically clustered per-position set (3–6, weight 1.0 default). |

---

*End of DOMAIN_GLOSSARY.md v1.*
