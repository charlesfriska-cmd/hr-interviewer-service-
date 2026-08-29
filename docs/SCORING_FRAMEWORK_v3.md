# SCORING_FRAMEWORK.md
## Evidence Quality, Scoring, Confidence, Weighting & Final Assessment

Status: Authoritative scoring methodology, **v3**. Supersedes `SCORING_FRAMEWORK.md` v2. Closes
implementation blockers B1 (competency gates/weighting), B2 (gate summary rename), and B6
(deterministic finalization algorithm). Sections not listed below are **unchanged from v2**. See
`DOMAIN_GLOSSARY.md` for canonical term meanings.

---

## Amendment index

| Blocker | Section(s) changed |
|---|---|
| B1 | §5.1 (competency weight sourcing), §6 (competency gates removed) |
| B2 | §6, §8, §11 (`mustHaveGateStatus` → `criticalGateStatus`) |
| B6 | §4 (confidence ordering made canonical/executable), §8 (full deterministic algorithm, replacing the v2 narrative version), §9 (config additions) |

---

## 4. Confidence Methodology (amended — B6: canonical ordering made explicit)

Unchanged bands/midpoints from v2. **New, canonical (B6):** confidence bands form a total order,
used by every tier-selection and gate-capping comparison in this document:

```typescript
// scoring.config.ts
export const CONFIDENCE_BAND_ORDER: ConfidenceBand[] =
  ["VERY_LOW", "LOW", "MODERATE", "HIGH", "VERY_HIGH"];
// index 0 = lowest. "meets or exceeds band X" means index >= indexOf(X).
```

Any comparison in this document of the form "confidence band at least HIGH" means
`CONFIDENCE_BAND_ORDER.indexOf(band) >= CONFIDENCE_BAND_ORDER.indexOf("HIGH")` — never a
string/exact-equality check, and never the numeric midpoint (the midpoint remains an internal
sort/storage key only, per v2, not a threshold input).

---

## 5. Scoring Architecture — Parallel Tracks, No Double Counting

### 5.1 Competency Score (amended — B1: explicit weight sourcing, no registry required)

Formula unchanged from v2:

```
competencyScore = Σ (competency.score × competency.weight) / Σ (competency.weight)
                   over all competencies where competency.score != null
```

**Weight sourcing (B1, canonical, replacing v2's `position_competency_weights` framing):**

| Competency kind | MVP weight source |
|---|---|
| Dynamically generated **position-specific** competency (`INTERVIEW_FRAMEWORK.md` §6) | Always `1.0`. No pre-authored position competency registry is required or consulted in MVP. Recruiter-configurable weighting for these is **`DEFER_TO_POST_MVP`**. |
| **Universal** competency (`INTERVIEW_FRAMEWORK.md` §5) | `scoring.config.ts`'s `universalCompetencyWeights` map (§9 below), defaulting to `1.0` for any tag not explicitly listed. This is versioned application configuration, not a per-recruiter database row. |

The `position_competency_weights` table described in `ARCHITECTURE.md` v2 §10 is **not required
for MVP launch** and, if implemented at all, is populated only for the deferred
recruiter-override feature — its absence must never block scoring, since the default (`1.0`)
always applies cleanly with no row present. `CompetencyAssessment.weight`
(`API_CONTRACT.md` v3 §2.6) is the field that actually carries whichever value this table
resolves to (or the `1.0` default) at finalization time.

Competencies never reaching adequate evidence (`score == null`) are excluded from numerator and
denominator, unchanged from v2, and appear in `unverifiedAreas` per `genuineAttempt`
(`INTERVIEW_STATE.md` v3 §5a).

### 5.2 Requirement Fit — unchanged from v2, except:

Wherever v2 said "plus any `CompetencyAssessment` rows where `isCriticalGate == true`" (its
Critical Gate Status slice definition), that clause is **deleted (B1)** — Critical Gate Status
is now defined purely as: rows (of either priority) where `JobRequirement.criticalGate == true`.
No competency contributes to this slice.

### 5.3 Minimum Evidence Threshold — unchanged from v2

Now formally keyed to `genuineAttempt` (`INTERVIEW_STATE.md` v3 §5a): an item without a
`genuineAttempt` is excluded from both weighted averages exactly as an `INSUFFICIENT_EVIDENCE`
item is, and is flagged `INSUFFICIENT_DATA` where a gate/finalization field exists for it.

---

## 6. Critical Gates (amended — B1: competency-level gates removed entirely)

**Resolution (B1):** the MVP system has **exactly one** gate mechanism:
`JobRequirement.criticalGate: boolean`. The v2 parallel competency-level gate
(`isCriticalGate` on a competency configuration record) is **removed in full** — not deferred,
not weakened, deleted. Rationale: position-specific competencies are generated dynamically per
interview with no stable pre-authored identity to hang a recruiter-configured gate off of in
MVP, and Universal competencies gaining gate status would blur the line between "a broad
capability we're worried about" and "a specific, recruiter-stated non-negotiable requirement,"
which is exactly the ambiguity `criticalGate` on `JobRequirement` already exists to express
cleanly. Any future need for a competency-level gate is a new, explicitly-scoped post-MVP
decision, not an MVP default.

**Gate evaluation (at finalization, deterministic) — unchanged mechanism, narrowed scope:**
- `gateStatus = "CLEARED"` if the gated `JobRequirement`'s linked `RequirementAssessment` clears
  `gateClearanceMinScore` (§9) with adequate evidence (`genuineAttempt == true` and not
  `INSUFFICIENT_EVIDENCE`).
- `gateStatus = "FAILED"` if it has adequate evidence but scores below that minimum.
- `gateStatus = "INSUFFICIENT_DATA"` if it never reached a `genuineAttempt`
  (`INTERVIEW_STATE.md` v3 §5a) at all.
- `gateStatus = "NOT_A_GATE"` for every `RequirementAssessment` where `criticalGate == false`.
- **`CompetencyAssessment` never carries a `gateStatus` field at all (B1)** — it is not merely
  always `NOT_A_GATE`, the field does not exist on that entity (`API_CONTRACT.md` v3 §2.6).

**Capping rule — unchanged in spirit, restated with renamed field (B2):**
- Any gate `FAILED` → `overallRecommendation` capped at `CONSIDER` at most (exact algorithm §8),
  surfaced in `riskFlags`.
- Any gate `INSUFFICIENT_DATA` → `overallRecommendation = INSUFFICIENT_DATA` outright (B6,
  §8 — stronger than v2's capping language, see rationale there).
- `criticalGateStatus` (**RENAMED from `mustHaveGateStatus`, B2** — `API_CONTRACT.md` v3 §2.9)
  is computed only across `JobRequirement` rows where `criticalGate == true`. The name change
  makes explicit what was already true in v2's mechanism: this field says nothing about
  MUST_HAVE rows that aren't configured gates.

---

## 7. Nice-to-Have Requirements — unchanged from v2

No automatic promotion rule exists. Structurally excluded from `overallRecommendation`'s
computation, unaffected by B1/B2/B6.

---

## 8. Overall Recommendation — Deterministic Finalization Algorithm (B6 — replaces v2 §8 in full)

**Design goal:** every step below is executable by Node.js with no LLM call and no ambiguity —
this is the canonical algorithm; no other document restates it (they point here).

### 8.1 Inputs

- `competencyScore: number | null`, `competencyConfidenceBand: ConfidenceBand`
- The full `RequirementAssessment[]` list, each with `coverageLevel`, `score`,
  `insufficientEvidenceFlag`, `gateStatus`, and its linked `JobRequirement.priority`/
  `.criticalGate`
- `scoring.config.ts`'s `recommendationTiers` and `gateClearanceMinScore` (§9)

### 8.2 Step 1 — Base tier from `competencyScore` + confidence (top-down, ALL conditions required)

Walk `recommendationTiers` from `STRONGLY_RECOMMENDED` down to `NOT_RECOMMENDED`. For each tier,
in order, check **both** of its conditions using `CONFIDENCE_BAND_ORDER` (§4) for the confidence
comparison:

```
tierSatisfied(tier) =
    competencyScore != null
    AND competencyScore >= tier.minCompetencyScore
    AND indexOf(competencyConfidenceBand) >= indexOf(tier.minConfidenceBand)
```

The **first** tier (highest to lowest) for which `tierSatisfied` is true is the base tier. If
`competencyScore == null` (no competency ever reached adequate evidence at all), skip directly
to §8.5 (this is itself a material-insufficiency case, handled there) rather than evaluating
tiers against a null score.

This resolves v2's ambiguity directly: a tier is never selected on score alone, or confidence
alone — both of that tier's conditions must hold, and if a higher tier's score condition holds
but its confidence condition does not, evaluation **continues downward** rather than either
(a) awarding the higher tier anyway or (b) stopping and treating the candidate as unscored.

### 8.3 Step 2 — Critical gate INSUFFICIENT_DATA override (checked before capping)

```
if ANY RequirementAssessment with criticalGate == true has gateStatus == "INSUFFICIENT_DATA":
    overallRecommendation = "INSUFFICIENT_DATA"
    riskFlags += "Critical gate '<label>' never reached adequate evidence"
    → STOP. Steps 8.4–8.6 do not run. This is a hard override, not a capped tier.
```

**Rationale for a hard override rather than a cap here (vs. FAILED, which only caps):** a
`FAILED` gate is a known, evidenced negative — `CONSIDER` still communicates real information
about a real result. An `INSUFFICIENT_DATA` gate means the process never actually tested a
non-negotiable requirement at all; presenting *any* positive-flavored tier (even `CONSIDER`)
would misrepresent an untested gate as a mildly-concerning-but-known one. `INSUFFICIENT_DATA` at
the overall level makes clear this is a process outcome demanding a real (likely re-interview)
follow-up, not a candidate judgment.

### 8.4 Step 3 — Critical gate FAILED capping

```
if ANY RequirementAssessment with criticalGate == true has gateStatus == "FAILED":
    tier = min(tier, "CONSIDER")   // using tier ordering STRONGLY_RECOMMENDED > RECOMMENDED > CONSIDER > NOT_RECOMMENDED
    riskFlags += "Critical gate '<label>' failed"
```

Multiple failed gates do not compound below `CONSIDER`'s floor via this rule alone — if the base
tier from §8.2 was already `NOT_RECOMMENDED`, it stays `NOT_RECOMMENDED` (capping only ever
lowers or leaves unchanged, never raises, consistent with v2's original capping principle).

### 8.5 Step 4 — Material MUST_HAVE (non-gate) insufficiency capping (NEW, B6)

**Material input**, for this rule, is any `RequirementAssessment` whose linked `JobRequirement`
has `criticalGate == true` **OR** `priority == "MUST_HAVE"` (gates are already fully handled in
§8.3/§8.4; this step covers the remaining material case — a MUST_HAVE requirement that is not a
configured gate).

```
if ANY material RequirementAssessment (per the definition above, excluding those already
   handled as gates in §8.3/§8.4) has insufficientEvidenceFlag == true OR was never a
   genuineAttempt:
    tier = min(tier, "CONSIDER")
    concerns += "<label> (MUST_HAVE) was not sufficiently evidenced"
```

This directly implements the instruction that a material `INSUFFICIENT_DATA`-equivalent input
must never silently allow a positive recommendation (`RECOMMENDED`/`STRONGLY_RECOMMENDED`) to
stand — it caps at `CONSIDER`, the same ceiling a `FAILED` gate receives, but does **not**
trigger the harder `INSUFFICIENT_DATA` override reserved for critical gates specifically (§8.3)
— a non-gate MUST_HAVE gap is real information worth a `CONSIDER`, not grounds to discard the
whole assessment as a process failure.

### 8.6 Step 5 — Nice-to-Have — unchanged, structurally excluded

No Nice-to-Have data is consulted anywhere in §8.2–8.5 (C6, unchanged).

### 8.7 Result

`overallRecommendation` is the tier surviving §8.2 → §8.5 (or the §8.3 hard override). This is
always presented alongside `competencyScore`, Requirement Fit, `criticalGateStatus`, and
`niceToHaveHighlights` as separate labeled sections — never as one opaque number (unchanged
principle from v2).

### 8.8 Worked example (illustrative, not a config value)

`competencyScore = 4.1`, `competencyConfidenceBand = HIGH` → base tier `RECOMMENDED` (meets
`minCompetencyScore: 3.5`/`minConfidenceBand: MODERATE`, and also clears `STRONGLY_RECOMMENDED`'s
score threshold of 4.3? No — 4.1 < 4.3, so `STRONGLY_RECOMMENDED` fails at §8.2, evaluation
continues to `RECOMMENDED`, which is satisfied). Suppose one critical-gate requirement is
`FAILED`: §8.4 caps the tier at `min(RECOMMENDED, CONSIDER) = CONSIDER`. Final:
`overallRecommendation = "CONSIDER"`, with a `riskFlags` entry naming the failed gate.

---

## 9. `scoring.config.ts` — amended (B1, B6 additions)

All v2 values are unchanged **except** as follows:

```typescript
// scoring.config.ts
export const SCORING_CONFIG_VERSION = "1.1.0-mvp";   // bumped (B1/B2/B6 changes)

export const MVP_CALIBRATION_DEFAULTS = {
  evidenceScoreTable: { /* unchanged from v2 */ },
  confidenceBandMidpoint: { /* unchanged from v2 */ },

  // NEW (B6) — canonical total order backing every confidence comparison in §4/§8
  confidenceBandOrder: ["VERY_LOW", "LOW", "MODERATE", "HIGH", "VERY_HIGH"],

  ratingThresholds: { STRONG: 4.0, ADEQUATE: 3.0, WEAK: 0.0 },

  // AMENDED (B1) — replaces v2's single defaultCompetencyWeight with an explicit map plus
  // fallback, so universal competencies can be individually tuned without touching code
  defaultCompetencyWeight: 1.0,
  universalCompetencyWeights: {
    // e.g. "communication": 1.0, "ownership": 1.2 — any tag not listed uses
    // defaultCompetencyWeight. Position-specific competencies ALWAYS use 1.0 in MVP
    // regardless of this map (see §5.1) — this map applies to universal tags only.
  },
  // Recruiter-configurable position-specific competency weighting: DEFER_TO_POST_MVP (B1).

  gateClearanceMinScore: 3.0,

  recommendationTiers: {
    STRONGLY_RECOMMENDED: { minCompetencyScore: 4.3, minConfidenceBand: "HIGH" },
    RECOMMENDED:          { minCompetencyScore: 3.5, minConfidenceBand: "MODERATE" },
    CONSIDER:             { minCompetencyScore: 2.5, minConfidenceBand: "LOW" },
    NOT_RECOMMENDED:      { minCompetencyScore: 0.0, minConfidenceBand: "VERY_LOW" },
  },
  // NOTE: NOT_RECOMMENDED's conditions are trivially satisfied by anything with a non-null
  // score, by design — it is the floor tier §8.2 falls through to if no higher tier's BOTH
  // conditions hold.

  phaseSoftBudgetShare: { /* unchanged from v2 */ },

  // NOTE (B4, cross-referenced, not a scoring value): maxCandidateResponseWindowSeconds and
  // sessionIdleTimeoutMinutes live on Interview/application deployment config
  // (API_CONTRACT.md v3 §2.1), not here — they are timing config, not scoring config.
};
```

**Removed (B1):** any competency-gate-related config key (none existed explicitly named in v2's
literal config beyond the now-deleted `isCriticalGate` field's implicit assumption of a
competency gate threshold) — no key to remove beyond what's already covered by §6's field
removal on the schema side.

---

## 10. Deterministic Templates — unchanged from v2

`RequirementAssessment.notes` / `CompetencyAssessment.rationale` templates are unaffected by
B1/B2/B6; `CompetencyAssessment.rationale`'s template simply never references a gate, since the
field no longer exists to reference.

---

## 11. Example Final Assessment (updated — B1, B2, B6 field names)

```json
{
  "interviewId": "int_8841",
  "scoringConfigVersion": "1.1.0-mvp",
  "competencyScore": 3.9,
  "competencyConfidenceBand": "HIGH",
  "overallRecommendation": "RECOMMENDED",
  "overallConfidenceBand": "HIGH",
  "criticalGateStatus": "ALL_CLEARED",
  "competencyAssessments": [
    { "competencyTag": "system_design", "coverageLevel": "COVERED", "rating": "STRONG", "score": 4, "confidenceBand": "HIGH", "weight": 1.0 },
    { "competencyTag": "incident_response", "coverageLevel": "PARTIALLY_COVERED", "rating": "ADEQUATE", "score": 3, "confidenceBand": "MODERATE", "weight": 1.0 },
    { "competencyTag": "communication", "coverageLevel": "COVERED", "rating": "STRONG", "score": 4, "confidenceBand": "HIGH", "weight": 1.0 }
  ],
  "requirementAssessments": [
    { "requirementId": "req_003", "coverageLevel": "COVERED", "score": 4, "confidenceBand": "HIGH", "gateStatus": "NOT_A_GATE", "notes": "Clear, specific ownership of architecture decisions with measurable outcomes." },
    { "requirementId": "req_005", "coverageLevel": "PARTIALLY_COVERED", "score": 3, "confidenceBand": "MODERATE", "gateStatus": "CLEARED", "notes": "Incident-response evidence based on a single instance; gate cleared at minimum threshold." },
    { "requirementId": "req_009", "coverageLevel": "NOT_COVERED", "score": null, "confidenceBand": "VERY_LOW", "gateStatus": "NOT_A_GATE", "notes": "Not reached due to time constraints." }
  ],
  "niceToHaveHighlights": ["Some familiarity with adjacent infrastructure tooling mentioned, though not formally probed (req_009)"],
  "keyStrengths": ["Clear, specific ownership of architecture decisions with measurable outcomes (req_003)", "Consistent communication clarity across all phases"],
  "concerns": ["Incident response evidence based on a single instance; would benefit from further validation before a safety-critical assignment"],
  "unverifiedAreas": ["req_009 (Kubernetes) — not reached due to time constraints"],
  "contradictions": [],
  "riskFlags": [],
  "recommendationRationale": "Candidate demonstrated strong, consistent evidence of system design ownership with measurable outcomes. The one configured critical gate (incident response) cleared at a moderate-confidence level. No unresolved contradictions. Recommended, with incident response flagged for optional further validation.",
  "generatedAt": "2026-08-29T00:00:00Z"
}
```

Note: no `CompetencyAssessment` row carries a gate field of any kind (B1); `criticalGateStatus`
(B2) replaces the old field name with identical value semantics.

---

## 12. Visualization Data Shapes — unchanged from v2

---

*End of SCORING_FRAMEWORK.md v3.*
