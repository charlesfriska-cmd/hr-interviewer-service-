# SCORING_FRAMEWORK.md
## Evidence Quality, Scoring, Confidence, Weighting & Final Assessment

Status: Authoritative scoring methodology (companion to `ARCHITECTURE.md` and `INTERVIEW_FRAMEWORK.md`)
Scope: How raw evidence becomes a defensible, auditable, bias-resistant assessment.

---

## 1. Evidence Quality Rubric

Evidence quality is judged along these factors, each contributing to the overall `evidence_strength` rating:

- **Specificity** — concrete details (what, who, when, how) vs. generic description.
- **Relevance** — direct applicability to the requirement/competency in question.
- **Candidate personal contribution** — "I" vs. "we"; identifiable individual action/decision.
- **Complexity** — appropriate difficulty/scope relative to the role level.
- **Measurable result** — a stated or inferable outcome, ideally quantified.
- **Consistency** — alignment with CV and other interview answers.
- **Recency** (where relevant) — more weight to recent evidence for fast-evolving skills; less critical for stable traits like ownership or communication style.
- **Depth** — evidence of genuine understanding (why, trade-offs considered) vs. surface-level description.

### Evidence Strength Scale

| Strength | Behavioral definition |
|---|---|
| **VERY_WEAK** | Generic claim, no specifics, no personal contribution, no result. Little more than a keyword match to the requirement. |
| **WEAK** | Some specificity or context, but missing personal contribution *or* result *or* both; largely team/outcome-level description. |
| **MODERATE** | Personal contribution is identifiable and the situation is concrete, but result is vague/unquantified or only one supporting instance exists. |
| **STRONG** | Concrete situation, clear personal contribution/decision-making, and a stated (possibly non-numeric) result; internally consistent. |
| **VERY_STRONG** | All of STRONG, plus measurable/quantified outcome, appropriate complexity for the role level, and either multiple corroborating instances or clear depth (trade-offs, reasoning, learning). |

`INSUFFICIENT` (used in the AI response schema, `ARCHITECTURE.md` Section 16) is reserved for **absence of usable evidence** (candidate could not answer, refused, or gave no relevant instance) — it is not a sixth point on this quality scale, it is a distinct "no data" state (see Section 5 below).

---

## 2. Competency Scoring Rubric (1–5, Job-Contextual)

| Score | Anchor | Meaning |
|---|---|---|
| **1** | Significantly Below Requirement | Evidence indicates capability clearly and substantially below what this specific role requires. |
| **2** | Below Requirement | Evidence indicates a gap versus what this role requires, though not severe. |
| **3** | Meets Requirement | Evidence indicates the candidate can perform this dimension at the level this role needs. |
| **4** | Exceeds Requirement | Evidence indicates capability beyond what this role strictly requires — for this role, not universally. |
| **5** | Significantly Exceeds Requirement | Evidence indicates capability substantially beyond this role's needs — potential over-qualification signal worth noting, not necessarily a red flag. |

**Job-contextual anchoring is mandatory.** A score of 4 for a first-line supervisor role and a score of 4 for a senior director role represent different absolute capability levels — both are calibrated against *this role's* expectations, derived from the JD/requirements, not a universal capability ladder.

**Hard rule:** a score is never lowered simply because evidence is unavailable. Absence of evidence produces `INSUFFICIENT_EVIDENCE` as a separate state (Section 3), never a low numeric score. Conflating "we didn't get to ask" with "the candidate is weak" is a critical scoring error the agent must avoid.

---

## 3. INSUFFICIENT_EVIDENCE as a Distinct State

Supported at both the `RequirementAssessment` and `CompetencyAssessment` level (`ARCHITECTURE.md` Section 9: `insufficientEvidenceFlag`, and `rating: "INSUFFICIENT_EVIDENCE"`).

Set `INSUFFICIENT_EVIDENCE` when:
- the objective was never reached (time/question budget exhausted first), or
- the candidate could not or would not produce a relevant instance despite reasonable probing, or
- available evidence is exclusively `VERY_WEAK`/generic with no personal contribution established at all.

This is deliberately **separate from a low score (1–2)**, which represents *evidence of weak performance*, not *absence of evidence*. Node.js enforces this distinction deterministically regardless of what the model outputs (`ARCHITECTURE.md` Section 16): whenever an objective closes with zero or only `INSUFFICIENT`-strength evidence, `insufficient_evidence_flag` is forced `true` irrespective of the model's chosen `coverage_level`.

---

## 4. Confidence Methodology

Confidence and score are always reported separately and must never be conflated.

> Score = 4.2, Confidence = 0.92 ≠ Score = 4.2, Confidence = 0.45

The first says "strong performance, well established." The second says "the little evidence we have looks strong, but we shouldn't bet heavily on it yet."

### Confidence factors (qualitative → banded, not falsely precise)

| Factor | Effect on confidence |
|---|---|
| Number of relevant evidence items | More independent instances → higher confidence |
| Evidence strength | STRONG/VERY_STRONG evidence contributes more confidence per item than WEAK |
| Consistency | Agreement across multiple answers/CV → higher; contradictions → lower |
| Directness | Direct behavioral evidence → higher; evidence obtained via inference only → lower |
| Completeness | Objective's `targetEvidenceCount` fully met → higher; partially met → lower |
| Unresolved contradictions | Any unresolved contradiction touching this dimension caps confidence, regardless of other factors |

### Practical confidence bands (avoid false mathematical precision)

| Band | Range | Typical basis |
|---|---|---|
| Very Low | 0.0–0.3 | Zero or one weak/very-weak evidence item, or unresolved contradiction present |
| Low | 0.3–0.5 | One moderate item, or multiple weak items only |
| Moderate | 0.5–0.7 | One strong item, or 2+ moderate items, consistent |
| High | 0.7–0.85 | 2+ strong items, consistent, target evidence count met |
| Very High | 0.85–1.0 | Multiple very-strong/strong items, fully consistent, target exceeded |

The agent should reason in these bands rather than manufacture spurious decimal precision (e.g., prefer "confidence ≈ 0.8, High band, based on two strong consistent evidence items" over inventing "0.847").

---

## 5. Weighting Methodology

Weighting exists to ensure the **final recommendation reflects what actually matters for the role**, not a flat average across every dimension asked about.

### Weighting inputs
- **Requirement priority** (`MUST_HAVE` weighted materially higher than `NICE_TO_HAVE`).
- **Position-specific importance** — some position-specific competencies are more central than others even within MUST_HAVE (e.g., Safety Awareness for a Production Supervisor is typically a gate-level item, not just a weighted factor — see Critical Gates below).
- **Universal competency weight** — generally moderate; rarely a critical gate on its own except Ownership/Integrity-adjacent concerns in specific contexts.
- **Recruiter override weight** (`job_requirements.recruiter_weight`, default 1.0) — a deterministic, Node.js-owned multiplier applied on top of the base weighting, never modified by the AI.

### Critical Gates

A **critical gate** is a MUST_HAVE requirement or safety/compliance-relevant competency where failure should materially cap the overall recommendation *regardless* of strong performance elsewhere. Examples: safety awareness for a floor-supervision role, a hard licensing/certification requirement, core legal/compliance knowledge for a regulated role.

**Rule: high performance in a low-priority (NICE_TO_HAVE or minor universal) competency must never compensate for failure on a critical gate.** Practically:
- If any critical-gate dimension scores 1–2 with adequate evidence (not `INSUFFICIENT_EVIDENCE`) → overall recommendation is capped at `CONSIDER` at best, regardless of other scores, and the gate failure must appear prominently in `concerns`/`riskFlags`.
- If a critical-gate dimension is `INSUFFICIENT_EVIDENCE` → overall recommendation is capped at `INSUFFICIENT_DATA` for that gate's scope, distinct from an actual failure — this must not be silently treated as a pass.

### Minimum Evidence Threshold

Before any MUST_HAVE requirement or critical-gate competency can contribute a numeric score to the overall weighted result, it must meet its `targetEvidenceCount` or have had a genuine, budget-respecting attempt (Section 12, `INTERVIEW_FRAMEWORK.md`). Requirements that never received a genuine attempt (e.g., interview cut short) are excluded from the weighted average and instead flagged `INSUFFICIENT_DATA` at the requirement level — they do not silently drag the average down or get skipped without a trace.

### Overall Assessment Methodology (practical, non-mathematically-elaborate)

1. Compute a weighted score across all requirements/competencies with adequate evidence, weight = requirement priority × position-specific importance × recruiter_weight.
2. Apply critical-gate capping (above) after the weighted score is computed — gates are a ceiling, not an additive term.
3. Roll the confidence bands (Section 4) into an overall confidence qualifier (e.g., "High confidence overall, driven by strong evidence on all MUST_HAVE items"; or "Moderate confidence — one critical competency remains INSUFFICIENT_EVIDENCE").
4. Translate the capped weighted score + confidence + gate status into one of the five recommendation categories (Section 7).

This intentionally avoids elaborate statistical machinery — a transparent, explainable weighting scheme is preferred over a black-box formula, because auditability (Priority #2 in `ARCHITECTURE.md`) outranks scoring sophistication.

---

## 6. Layer Interaction — Must-Have vs. Nice-to-Have Fit

Reported separately in the final assessment (never merged into one number):

- **Must-Have Requirement Fit** — per-requirement coverage + score + confidence, plus an aggregate "all gates cleared / one or more gates failed or unresolved" flag.
- **Nice-to-Have Requirement Fit** — same structure, but never gates the overall recommendation; can only push a borderline case upward, never rescue a MUST_HAVE failure.

---

## 7. Final Assessment Method

`FinalAssessment` (per `ARCHITECTURE.md` Section 9) is assembled from already-persisted `Evidence` and per-turn `RequirementAssessment`/`CompetencyAssessment` rollups — it aggregates, it does not re-derive from raw transcript (`ARCHITECTURE.md` Section 18).

Contents:

- **Overall Recommendation** (Section 8 below)
- **Overall Score** — reported only where meaningful (i.e., not if critical gates are `INSUFFICIENT_DATA`); otherwise explicitly marked not applicable rather than forcing a number.
- **Confidence** — overall qualifier per Section 4/5.
- **Must-Have Requirement Fit** — full per-requirement breakdown.
- **Nice-to-Have Requirement Fit** — full per-requirement breakdown.
- **Universal Competency Assessment** — per-dimension score/confidence.
- **Position-Specific Competency Assessment** — per-dimension score/confidence.
- **Key Strengths** — evidence-backed, specific, tied to requirement/competency IDs.
- **Concerns** — evidence-backed, specific; explicitly excludes anything touching protected characteristics (Section 17, `INTERVIEW_FRAMEWORK.md`).
- **Unverified Areas** — objectives that ended `INSUFFICIENT_EVIDENCE`.
- **Contradictions** — resolved and unresolved, each with a one-line factual description.
- **Risk Flags** — only where job-relevant (e.g., a critical gate failure, an unresolved contradiction on a MUST_HAVE item) — never speculative or personal.
- **Recommendation Rationale** — a short, evidence-referencing paragraph, not chain-of-thought; it should read like a hiring manager's summary note, not a model's internal deliberation.

---

## 8. Overall Recommendation Categories

| Recommendation | Typical basis |
|---|---|
| **STRONGLY_RECOMMENDED** | All critical gates cleared with STRONG/VERY_STRONG evidence, high confidence, no unresolved material contradictions |
| **RECOMMENDED** | Critical gates cleared, generally strong-to-moderate evidence, high-to-moderate confidence, minor unresolved gaps only in NICE_TO_HAVE areas |
| **CONSIDER** | Mixed picture — some MUST_HAVE evidence weak/moderate, or one gate scored low (not `INSUFFICIENT_EVIDENCE`) but not clearly disqualifying, or confidence moderate with real but non-fatal open questions |
| **NOT_RECOMMENDED** | One or more critical gates scored 1–2 with adequate evidence, or multiple MUST_HAVE requirements clearly NOT_COVERED with genuine attempts made |
| **INSUFFICIENT_DATA** | Interview ended (time/technical issue) before critical gates or MUST_HAVE requirements could be genuinely attempted — this is a process outcome, not a judgment on the candidate, and should be clearly labeled as such for the recruiter |

The recommendation is always presented **alongside the full evidence trail** (`ARCHITECTURE.md` Section 25/26), never as an opaque score — the design intent is recruiter-assisted decision-making, not automated accept/reject.

---

## 9. Example Final Assessment

```json
{
  "interviewId": "int_8841",
  "overallRecommendation": "RECOMMENDED",
  "overallScoreNote": "Weighted 3.8/5 across MUST_HAVE dimensions; NICE_TO_HAVE not included in overall score per methodology",
  "confidence": "High — driven by consistent, multi-instance evidence on all MUST_HAVE dimensions",
  "mustHaveFit": [
    {
      "requirementId": "req_003",
      "label": "System design ownership",
      "coverageLevel": "COVERED",
      "score": 4,
      "confidence": "High (0.85 band)",
      "evidenceIds": ["ev_101", "ev_104", "ev_107"]
    },
    {
      "requirementId": "req_005",
      "label": "Safety-critical incident response (critical gate)",
      "coverageLevel": "PARTIALLY_COVERED",
      "score": 3,
      "confidence": "Moderate (0.6 band)",
      "evidenceIds": ["ev_112"],
      "gateStatus": "CLEARED"
    }
  ],
  "niceToHaveFit": [
    {
      "requirementId": "req_009",
      "label": "Familiarity with Kubernetes",
      "coverageLevel": "NOT_COVERED",
      "insufficientEvidenceFlag": true
    }
  ],
  "universalCompetencies": [
    { "competency": "Communication", "score": 4, "confidence": "High" },
    { "competency": "Ownership", "score": 4, "confidence": "High" },
    { "competency": "Adaptability", "score": 3, "confidence": "Moderate" }
  ],
  "positionSpecificCompetencies": [
    { "competency": "System Design", "score": 4, "confidence": "High" },
    { "competency": "Incident Response", "score": 3, "confidence": "Moderate" }
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
  "recommendationRationale": "Candidate demonstrated strong, consistent evidence of system design ownership with measurable outcomes across multiple examples. Incident-response evidence, while positive, rests on a single account and carries moderate rather than high confidence — worth a light follow-up if the role has significant on-call exposure. No unresolved contradictions. Recommended, with the incident-response area flagged for optional further validation."
}
```

---

## 10. Visualization Data Shapes (Reference)

See `INTERVIEW_FRAMEWORK.md` Section 19 for recommended chart types. This document supplies the underlying numeric contract each visualization consumes:

- Radar Chart → array of `{ competency, score, confidence }` across Layer A + Layer B.
- Weighted Scorecard → array of `{ requirementOrCompetency, score, weight, gateStatus }`.
- Requirement-Match Matrix → array of `{ requirement, priority, coverageLevel, confidence }`.
- Competency Heatmap (multi-candidate) → matrix of `{ candidateId, competency, score }`.
- Score vs. Confidence → array of `{ dimension, score, confidence }` for scatter plotting; the "strong-looking but thin evidence" quadrant is simply high score + low/moderate confidence band.

The LLM/orchestrator emit only this structured data; all rendering is a frontend concern outside this document's scope.
