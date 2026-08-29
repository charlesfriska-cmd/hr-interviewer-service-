# SCORING_FRAMEWORK.md
## Evidence Quality, Scoring, Confidence, Weighting & Final Assessment

Status: Authoritative scoring methodology, **v2**. Supersedes v1. Closes implementation
blockers C4, C5, C6, C7 identified by Claude Code Plan Mode. Companion to `ARCHITECTURE.md`,
`INTERVIEW_FRAMEWORK.md`, and `API_CONTRACT.md` v2 (which defines the exact persisted shapes
this document's methodology populates).

---

## 1. Evidence Quality Rubric & Strength Scale (unchanged from v1)

Evidence quality factors: specificity, relevance, personal contribution, complexity, measurable
result, consistency, recency, depth.

| Strength | Behavioral definition |
|---|---|
| **VERY_WEAK** | Generic claim, no specifics, no personal contribution, no result. |
| **WEAK** | Some specificity/context, but missing personal contribution *or* result *or* both. |
| **MODERATE** | Personal contribution identifiable, concrete situation, but result vague/unquantified or only one instance. |
| **STRONG** | Concrete situation, clear personal contribution/decision-making, stated result, internally consistent. |
| **VERY_STRONG** | All of STRONG, plus quantified outcome, appropriate complexity, and either multiple corroborating instances or clear depth. |

`INSUFFICIENT` is a distinct "no usable evidence" state, not a sixth quality point (§3).

---

## 2. Competency Scoring Rubric (1–5, job-contextual) — unchanged anchors

| Score | Anchor | Meaning |
|---|---|---|
| **1** | Significantly Below Requirement | |
| **2** | Below Requirement | |
| **3** | Meets Requirement | |
| **4** | Exceeds Requirement | |
| **5** | Significantly Exceeds Requirement | |

Job-contextual anchoring is mandatory. **Hard rule, unchanged:** a score is never lowered
because evidence is unavailable — absence of evidence produces `INSUFFICIENT_EVIDENCE`, never a
low numeric score.

### 2a. Rating Derivation (C7 — NEW, resolves prior ambiguity)

`CompetencyAssessment.rating` is **derived**, not model-supplied, using continuous range
thresholds from `scoring.config.ts` (§9), not exact-value equality:

```typescript
// scoring.config.ts (excerpt) — MVP_CALIBRATION_DEFAULTS, versioned and replaceable
const RATING_THRESHOLDS = {
  STRONG:   { minScore: 4.0 },   // score >= 4.0            → STRONG
  ADEQUATE: { minScore: 3.0 },   // 3.0 <= score < 4.0       → ADEQUATE
  WEAK:     { minScore: 0.0 },   // 0   <= score < 3.0       → WEAK
  // score === null                                          → INSUFFICIENT_EVIDENCE
};
```

Node.js walks the thresholds from highest to lowest and takes the first band whose `minScore`
the computed `score` meets or exceeds; `score === null` (never reached target evidence, or only
`INSUFFICIENT` evidence) always maps to `INSUFFICIENT_EVIDENCE` regardless of threshold values.
This is the same pattern applicable to any future re-calibration — only the config values
change, never the derivation logic.

---

## 3. `INSUFFICIENT_EVIDENCE` as a Distinct State (unchanged from v1)

Set when the objective was never reached, the candidate could not/would not produce a relevant
instance despite reasonable probing, or available evidence is exclusively `VERY_WEAK`/generic.
Deliberately separate from a low score (1–2). Node.js enforces this deterministically regardless
of the AI's stated `coverage_level` — whenever an objective closes with zero or only
`INSUFFICIENT`-strength evidence, `insufficientEvidenceFlag` is forced `true`.

---

## 4. Confidence Methodology (unchanged from v1)

Confidence and score are always reported separately. Confidence factors: number of relevant
evidence items, evidence strength, consistency, directness, completeness against
`targetEvidenceCount`, unresolved contradictions (which cap confidence regardless of other
factors).

| Band | Range | Typical basis |
|---|---|---|
| Very Low | 0.0–0.3 | Zero/one weak item, or unresolved contradiction present |
| Low | 0.3–0.5 | One moderate item, or multiple weak items only |
| Moderate | 0.5–0.7 | One strong item, or 2+ moderate items, consistent |
| High | 0.7–0.85 | 2+ strong items, consistent, target evidence count met |
| Very High | 0.85–1.0 | Multiple very-strong/strong items, fully consistent, target exceeded |

Band-to-midpoint mapping (unchanged from `API_CONTRACT.md` v1 §5.4, retained):
`VERY_LOW→0.15, LOW→0.4, MODERATE→0.6, HIGH→0.775, VERY_HIGH→0.925`.

---

## 5. Scoring Architecture — Parallel Tracks, No Double Counting (C5 — MODIFIED, canonical)

**Problem being fixed:** v1 computed a single weighted average blending both requirement-level
and competency-level scores. Because a requirement and its linked competency can share the same
underlying evidence, this risked counting one piece of evidence twice toward the same overall
number, and conflated "does the candidate meet this specific requirement" with "how capable is
the candidate on this competency dimension" — two related but distinct questions.

**Resolution:** two parallel, independently-computed outputs, never numerically merged.

### 5.1 Competency Score (drives the primary recommendation signal)

Computed **only** from `CompetencyAssessment` rows (Universal + Position-Specific dimensions).

```
competencyScore = Σ (competency.score × competency.weight) / Σ (competency.weight)
                   over all competencies where competency.score != null
```

**Competency weight source (NEW, explicit per this revision):**
- Stored per-position in a `position_competency_weights` table (or `positions.competencyWeights`
  JSONB column — implementer's choice, no new infra required): `{ competencyTag, weight }`.
- **MVP default: equal weight (1.0) for every competency** unless the recruiting
  application/job configuration explicitly supplies a different weight for a specific
  `competencyTag` on that position. This is an `MVP_CALIBRATION_DEFAULTS` value (§9) —
  replaceable without a schema change.
- Competencies flagged `isCriticalGate: true` (§6 below) still participate in `competencyScore`
  at their configured weight; the gate mechanic is a separate **capping** step (§6), not a
  weight multiplier.

Competencies never reaching adequate evidence (`score == null`) are excluded from both the
numerator and denominator — they do not silently drag the average down, and they appear in
`unverifiedAreas` instead.

### 5.2 Requirement Fit (reported separately, never blended into `competencyScore`)

Computed from `RequirementAssessment` rows, viewed in three slices (all derived from the same
underlying array by filtering on `JobRequirement.priority` / `.criticalGate` — no duplicate
storage):

- **Must-Have Fit** — rows where `priority == "MUST_HAVE"`.
- **Nice-to-Have Fit** — rows where `priority == "NICE_TO_HAVE"`.
- **Critical Gate Status** — rows (of either priority) where `JobRequirement.criticalGate ==
  true`, plus any `CompetencyAssessment` rows where `isCriticalGate == true`.

Requirement Fit does **not** produce its own single numeric average that feeds
`overallRecommendation` additively. It contributes in exactly two ways:
1. **Gate capping** (§6) — a hard ceiling on the recommendation.
2. **Reporting** — `mustHaveGateStatus`, per-requirement `coverageLevel`/`score`/`notes` shown
   to the recruiter alongside `competencyScore`, so the recruiter sees both "how capable is this
   person" and "did they specifically demonstrate what this role's must-haves require" without
   one silently overwhelming the other in a single blended figure.

### 5.3 Minimum Evidence Threshold (unchanged from v1)

Before any MUST_HAVE requirement or critical-gate competency can contribute a numeric score
(to either track), it must meet its `targetEvidenceCount` or have had a genuine,
budget-respecting attempt. Items that never received a genuine attempt are excluded from both
weighted averages and flagged `INSUFFICIENT_DATA`/`unverifiedAreas` — never silently averaged in
and never silently skipped without a trace.

---

## 6. Critical Gates (C4 — MODIFIED, `criticalGate` is independent of `MUST_HAVE`)

**Resolution:** `MUST_HAVE` (a priority label describing how much interview time and reporting
weight a requirement gets) and `criticalGate` (a hard pass/fail ceiling on the recommendation)
are **separate, independently-configured fields**. `JobRequirement.criticalGate: boolean`
(`API_CONTRACT.md` §2.4) defaults `false` and is set only by explicit recruiter/job
configuration — never inferred from `priority`, never set or suggested by the AI. The same
independence applies to competency-level gates via `isCriticalGate` on the competency
configuration record.

**Gate evaluation (at finalization, deterministic):**
- `gateStatus = "CLEARED"` if the gated item's `coverageLevel`/`score` clears a configured
  minimum (default: `score >= 3` — a `scoring.config.ts` value, §9) with adequate evidence (not
  `INSUFFICIENT_EVIDENCE`).
- `gateStatus = "FAILED"` if it has adequate evidence but scores below that minimum.
- `gateStatus = "INSUFFICIENT_DATA"` if the item never reached adequate evidence at all —
  distinct from an actual failure, must not be silently treated as a pass.
- `gateStatus = "NOT_A_GATE"` for every item where `criticalGate`/`isCriticalGate` is `false`.

**Capping rule (unchanged in spirit from v1, now explicitly a ceiling on `competencyScore`'s
derived recommendation, never an input to `competencyScore` itself):**
- Any gate `FAILED` → `overallRecommendation` capped at `CONSIDER`, gate failure surfaced
  prominently in `riskFlags`.
- Any gate `INSUFFICIENT_DATA` → that gate's scope capped at `INSUFFICIENT_DATA`, never
  silently treated as a pass.
- `mustHaveGateStatus` (`API_CONTRACT.md` §2.9) is computed only across items where
  `criticalGate == true` — **not** across every `MUST_HAVE` row, which was the ambiguity in v1
  that this revision closes.

---

## 7. Nice-to-Have Requirements (C6 — REJECTED auto-promotion, REFRAMED as informational)

**v1 behavior (rejected):** any implicit or explicit rule that Nice-to-Have coverage could
promote `CONSIDER → RECOMMENDED` is removed. **No automatic promotion rule of any kind exists
for Nice-to-Have items in the MVP.**

**Canonical behavior:**
- Nice-to-Have Fit is computed and reported (§5.2) exactly like Must-Have Fit, structurally.
- It never appears as a positive or negative input to `overallRecommendation`'s core
  computation (§8).
- Notable Nice-to-Have coverage is surfaced separately as `FinalAssessment.niceToHaveHighlights`
  — visible to recruiters/hiring managers as *additional context* ("also demonstrated familiarity
  with X, which was nice-to-have"), never as a scoring input.
- **Critical Must-Have or Critical Gate failures can never be rescued by Nice-to-Have
  performance, under any configuration.** This is enforced structurally (Nice-to-Have data
  never enters the gate-capping function at all) rather than by a rule that could be
  accidentally bypassed.

---

## 8. Overall Recommendation Categories (unchanged enum, computation clarified)

| Recommendation | Typical basis |
|---|---|
| **STRONGLY_RECOMMENDED** | High `competencyScore`, all gates `CLEARED`, high confidence, no unresolved material contradictions |
| **RECOMMENDED** | Good `competencyScore`, all gates `CLEARED`, moderate-to-high confidence, minor gaps only in Nice-to-Have areas |
| **CONSIDER** | Mixed `competencyScore`, or one gate `FAILED` (not disqualifying alone but material), or moderate confidence with real open questions |
| **NOT_RECOMMENDED** | Low `competencyScore`, or one or more gates `FAILED` with adequate evidence, clearly disqualifying |
| **INSUFFICIENT_DATA** | Interview ended before critical gates or enough of `competencyScore`'s inputs could be genuinely attempted — a process outcome, not a judgment on the candidate |

**Computation order (canonical, replaces v1's single-pass description):**
1. Derive a base recommendation tier purely from `competencyScore` + `competencyConfidenceBand`
   (thresholds in `scoring.config.ts`, §9).
2. Apply gate capping (§6) — can only lower the tier, never raise it.
3. Nice-to-Have data is never consulted in steps 1–2 (§7).
4. If any required input to step 1 is `INSUFFICIENT_DATA`-flagged and material, the result is
   `INSUFFICIENT_DATA` regardless of what steps 1–2 would otherwise produce.

The recommendation is always presented **alongside** `competencyScore`, Must-Have Fit,
Critical Gate Status, and Nice-to-Have Highlights as separate, clearly labeled sections — never
as one opaque number.

---

## 9. `scoring.config.ts` — Versioned Deterministic Configuration (C5 — NEW)

All thresholds and weights referenced in this document live in one versioned config module, not
scattered inline in business logic:

```typescript
// scoring.config.ts
export const SCORING_CONFIG_VERSION = "1.0.0-mvp";

/**
 * MVP_CALIBRATION_DEFAULTS
 * ------------------------
 * Every value below is a starting default, not a validated calibration. These are explicitly
 * expected to be replaced once real interview outcome data exists. Changing a value here is a
 * config change, never an architecture change, and every FinalAssessment should record which
 * SCORING_CONFIG_VERSION produced it (add `scoringConfigVersion: string` to FinalAssessment —
 * see note below) so historical assessments remain interpretable after recalibration.
 */
export const MVP_CALIBRATION_DEFAULTS = {

  // Evidence-strength-and-coverage → 1-5 score lookup (INTERVIEW_STATE.md §8.1)
  evidenceScoreTable: {
    VERY_STRONG: { COVERED: 5, PARTIALLY_COVERED: 4, NOT_COVERED: 3 },
    STRONG:      { COVERED: 4, PARTIALLY_COVERED: 3, NOT_COVERED: 2 },
    MODERATE:    { COVERED: 3, PARTIALLY_COVERED: 2, NOT_COVERED: 2 },
    WEAK:        { COVERED: 2, PARTIALLY_COVERED: 2, NOT_COVERED: 1 },
    VERY_WEAK:   { COVERED: 1, PARTIALLY_COVERED: 1, NOT_COVERED: 1 },
    // INSUFFICIENT (or no evidence) => insufficientEvidenceFlag = true, score = null
  },

  // Confidence band → numeric midpoint (SCORING_FRAMEWORK.md §4)
  confidenceBandMidpoint: {
    VERY_LOW: 0.15, LOW: 0.4, MODERATE: 0.6, HIGH: 0.775, VERY_HIGH: 0.925,
  },

  // Competency rating derivation (§2a)
  ratingThresholds: {
    STRONG: 4.0, ADEQUATE: 3.0, WEAK: 0.0, // score === null => INSUFFICIENT_EVIDENCE
  },

  // Default competency weight if no job-specific weight is configured (§5.1)
  defaultCompetencyWeight: 1.0,

  // Gate clearance minimum score (§6)
  gateClearanceMinScore: 3.0,

  // Overall recommendation tiering from competencyScore (§8), pre-gate-capping
  recommendationTiers: {
    STRONGLY_RECOMMENDED: { minCompetencyScore: 4.3, minConfidenceBand: "HIGH" },
    RECOMMENDED:          { minCompetencyScore: 3.5, minConfidenceBand: "MODERATE" },
    CONSIDER:             { minCompetencyScore: 2.5, minConfidenceBand: "LOW" },
    NOT_RECOMMENDED:      { minCompetencyScore: 0.0, minConfidenceBand: "VERY_LOW" },
  },

  // Phase soft-budget allocation, as a fraction of overall duration/questions (INTERVIEW_STATE.md §4a)
  phaseSoftBudgetShare: {
    OPENING: 0.10, EXPERIENCE_VALIDATION: 0.25, COMPETENCY_DEEP_DIVE: 0.35,
    MOTIVATION_FIT: 0.15, CLARIFICATION: 0.15,
  },
};
```

**Note:** `FinalAssessment` (`API_CONTRACT.md` §2.9) should carry a `scoringConfigVersion:
string` field set to `SCORING_CONFIG_VERSION` at generation time, so that a later change to
`MVP_CALIBRATION_DEFAULTS` never silently reinterprets a historical assessment. This is a small
additive field; implementers should add it alongside the rest of §2.9 during implementation.

All values under `MVP_CALIBRATION_DEFAULTS` are placeholders pending real calibration data —
they are functional and internally consistent for MVP launch, but should be treated as the
first candidate for revision once outcome data (e.g., correlation between `competencyScore` and
actual on-the-job performance) is available.

---

## 10. `RequirementAssessment.notes` / `CompetencyAssessment.rationale` — Deterministic Templates (C8)

**Resolution:** no final-assessment LLM pass is introduced. Both fields are assembled by a fixed
Node.js template from already-persisted data:

```
notes = template(
  coverageLevel,
  topEvidenceSummaries (up to 2, highest-strength first),
  concerns (any CONCERN-type evidence gaps or unresolved contradictions touching this item),
  unresolvedGapDescriptions (any OPEN EvidenceGap rows for the linked objective at close time)
)
```

Example rendering: *"Partially covered. Candidate described owning the architecture decision
for a service migration and unblocking two downstream teams. One outstanding gap: measurable
outcome not established before the interview concluded."*

This keeps the narrative evidence-traceable and auditable without adding a new LLM call, a new
failure mode, or new prompt-injection surface at the finalization boundary.

---

## 11. Example Final Assessment (updated shape, C4/C5/C6/C7)

```json
{
  "interviewId": "int_8841",
  "scoringConfigVersion": "1.0.0-mvp",
  "competencyScore": 3.9,
  "competencyConfidenceBand": "HIGH",
  "overallRecommendation": "RECOMMENDED",
  "overallConfidenceBand": "HIGH",
  "mustHaveGateStatus": "ALL_CLEARED",
  "competencyAssessments": [
    { "competencyTag": "system_design", "coverageLevel": "COVERED", "rating": "STRONG", "score": 4, "confidenceBand": "HIGH", "isCriticalGate": false, "gateStatus": "NOT_A_GATE" },
    { "competencyTag": "incident_response", "coverageLevel": "PARTIALLY_COVERED", "rating": "ADEQUATE", "score": 3, "confidenceBand": "MODERATE", "isCriticalGate": true, "gateStatus": "CLEARED" },
    { "competencyTag": "communication", "coverageLevel": "COVERED", "rating": "STRONG", "score": 4, "confidenceBand": "HIGH", "isCriticalGate": false, "gateStatus": "NOT_A_GATE" }
  ],
  "requirementAssessments": [
    {
      "requirementId": "req_003", "coverageLevel": "COVERED", "score": 4, "confidenceBand": "HIGH",
      "gateStatus": "NOT_A_GATE", "notes": "Clear, specific ownership of architecture decisions with measurable outcomes."
    },
    {
      "requirementId": "req_005", "coverageLevel": "PARTIALLY_COVERED", "score": 3, "confidenceBand": "MODERATE",
      "gateStatus": "CLEARED", "notes": "Incident-response evidence based on a single instance; gate cleared at minimum threshold."
    },
    {
      "requirementId": "req_009", "coverageLevel": "NOT_COVERED", "score": null, "confidenceBand": "VERY_LOW",
      "gateStatus": "NOT_A_GATE", "notes": "Not reached due to time constraints."
    }
  ],
  "niceToHaveHighlights": [
    "Some familiarity with adjacent infrastructure tooling mentioned, though not formally probed (req_009)"
  ],
  "keyStrengths": [
    "Clear, specific ownership of architecture decisions with measurable outcomes (req_003)",
    "Consistent communication clarity across all phases"
  ],
  "concerns": [
    "Incident response evidence based on a single instance; would benefit from further validation before a safety-critical assignment"
  ],
  "unverifiedAreas": ["req_009 (Kubernetes) — not reached due to time constraints"],
  "contradictions": [],
  "riskFlags": [],
  "recommendationRationale": "Candidate demonstrated strong, consistent evidence of system design ownership with measurable outcomes. The one configured critical gate (incident response) cleared at a moderate-confidence level. No unresolved contradictions. Recommended, with incident response flagged for optional further validation.",
  "generatedAt": "2026-08-29T00:00:00Z"
}
```

Note the structural separation: `competencyScore` (3.9, from competencies only) is never mixed
with the individual `requirementAssessments[].score` values (4, 3, null) — they are reported
side by side, and only gate status from the requirement/competency side can cap the
recommendation derived from `competencyScore`.

---

## 12. Visualization Data Shapes (unchanged from v1)

See `INTERVIEW_FRAMEWORK.md` §19. Underlying numeric contracts unchanged except that "Weighted
Scorecard" and "Score vs. Confidence" visualizations should now clearly separate competency-score
data points from requirement-fit data points (two series, not one blended series), consistent
with §5's parallel-track model.

---

*End of SCORING_FRAMEWORK.md v2.*
