# INTERVIEW_FRAMEWORK.md
## Interview Intelligence Design — HR Interviewer Agent

Status: Authoritative interview-methodology specification (companion to `ARCHITECTURE.md`)
Scope: What the single HR Interviewer Agent thinks and decides. Does not alter the Node.js/TypeScript orchestration architecture.
Consumers: LLM prompt design, schema design, and Claude Code implementation of the orchestrator's rules engine.

---

## 1. Interview Methodology — Overview

The agent operates in one continuous loop, repeated once at initialization (planning) and once per candidate turn (adaptive questioning):

**Plan → Ask → Listen → Extract Evidence → Evaluate Evidence → Identify Gaps → Decide Next Action → Continue or Complete**

Two invocation modes, one methodology:

| Mode | Trigger | Output |
|---|---|---|
| **Initialization** | Interview created | `InterviewPlan` (objectives, requirement mapping, phase allocation) + first question |
| **Turn** | Candidate submits an answer | Evidence extracted from the answer, evaluated, gaps updated, one `recommended_action` + next question (or completion) |

The agent never asks more than **one primary question at a time**. It never executes a fixed questionnaire — the plan sets *objectives and priorities*, not a scripted question list. Node.js enforces all hard limits (Section 4/13 of `ARCHITECTURE.md`); the agent's job is to make each question inside those limits count.

---

## 2. Requirement-to-CV Mapping Method

Performed once, during Phase 0, for every `JobRequirement` (and inferred universal competencies).

For each requirement, the agent produces:

```
requirement, requirement_category, priority (MUST_HAVE | NICE_TO_HAVE),
cv_evidence (short extract or "none found"),
initial_match (STRONG_MATCH | PARTIAL_MATCH | UNKNOWN | POTENTIAL_GAP),
confidence (0–1, confidence in the CV-derived match itself, not the candidate's competence),
interview_objective (what the interview needs to establish),
required_evidence (what would count as sufficient proof),
interview_priority (1 = highest)
```

**Core rule: CV evidence is not verified interview evidence.** It only changes *how much* interview time a requirement deserves, never whether it needs any evidence at all.

### Decision rules — validate briefly vs. explore vs. deeply probe vs. deprioritize

| CV signal | Priority | Requirement priority | Treatment |
|---|---|---|---|
| STRONG_MATCH | MUST_HAVE | high | Brief validation only — one targeted question confirming personal contribution and recency. Do not re-derive from scratch. |
| STRONG_MATCH | NICE_TO_HAVE | low | Brief validation, or skip if time-constrained and other gaps dominate. |
| PARTIAL_MATCH | MUST_HAVE | high | Explore — dedicate a full objective; likely needs 1–2 follow-ups to resolve ambiguity. |
| PARTIAL_MATCH | NICE_TO_HAVE | medium | Explore briefly; do not deep-dive unless time allows. |
| UNKNOWN | MUST_HAVE | highest | Deeply probe — this is the highest information-gain category (Section 13). |
| UNKNOWN | NICE_TO_HAVE | low-medium | Explore if time permits; otherwise defer/deprioritize. |
| POTENTIAL_GAP | MUST_HAVE | highest | Deeply probe — confirm whether the gap is real, partially mitigated, or a CV-parsing artifact. |
| POTENTIAL_GAP | NICE_TO_HAVE | low | Note as a risk flag; do not spend scarce time unless nothing higher-priority remains. |

"Brief validation" = 1 question, no automatic follow-up unless the answer itself introduces a new gap or contradiction. "Deep probe" = budget for up to `maxFollowUpsPerObjective` before moving on.

---

## 3. Interview Planning Method (Phase 0 — Pre-Interview Planning)

Inputs: Position, Job Description, Job Requirements (with priority), CV, optional Company Context / Organizational Values.

Planning steps performed by the agent, returned as the `InterviewPlan`:

1. Build the Requirement-to-CV Mapping (Section 2).
2. Derive the **competency map**: merge Universal Competencies (Section 5) applicable to the role with Position-Specific Competencies (Section 6) derived from the requirements/JD.
3. Group requirements and competencies into **interview objectives** — one objective typically covers one competency or one tightly related cluster of requirements, never a single narrow fact.
4. Assign each objective to a phase (Section 4) based on its nature: experience/scope facts → Phase 2; behavioral competencies → Phase 3; motivation/fit → Phase 4.
5. Set `targetEvidenceCount` per objective (typically 1 for STRONG_MATCH/low-priority, 2–3 for UNKNOWN/POTENTIAL_GAP/MUST_HAVE).
6. Rank objectives within each phase by `interview_priority` (Section 13) — this ordering is a recommendation; Node.js still allows the agent to reorder adaptively within a phase based on what emerges.
7. Flag initial evidence gaps explicitly (objectives with `initial_match` of UNKNOWN or POTENTIAL_GAP) so the rules engine and recruiter view can see, before a single question is asked, what the interview is designed to resolve.
8. Produce the first question — always an opening/context question (Phase 1), never a competency probe as the very first turn.

The plan is a **prioritized map, not a script**. Within it, the turn-level loop (Section 4 below) decides in real time which objective to pursue next, when to follow up, and when to move on.

---

## 4. Interview Phase Matrix

| Phase | Target Duration | Entry Criteria | Objectives | Evidence Expectation | Exit Criteria |
|---|---|---|---|---|---|
| **0 — Pre-Interview Planning** | N/A (pre-call) | Interview created, inputs persisted | Produce Requirement-to-CV Mapping, competency map, objectives, priorities, initial gaps | N/A — no candidate evidence yet | Valid `InterviewPlan` passes schema + rules validation |
| **1 — Opening & Context** | 3–5 min | Plan approved | Build rapport; confirm candidate context (current role, situation, availability); observe baseline communication | Light — no scoring pressure; light-touch confirmation of headline CV facts | 1–2 opening exchanges completed, or Node.js phase question-cap reached |
| **2 — CV & Experience Validation** | 10–15 min | Phase 1 complete | Validate scope, responsibility, contribution, achievements, progression for CV-derived claims; surface unclear claims/inconsistencies | Moderate–Strong for MUST_HAVE experience claims; light for STRONG_MATCH items | All high-priority experience objectives reach SATISFIED or INSUFFICIENT_EVIDENCE, or Node.js cap reached |
| **3 — Competency Deep Dive** | 15–20 min | Phase 2 complete | Evidence-based behavioral assessment of Universal + Position-Specific competencies | Strong for MUST_HAVE competencies; Moderate acceptable for NICE_TO_HAVE | All critical competencies SATISFIED or INSUFFICIENT_EVIDENCE, or cap reached |
| **4 — Motivation & Organizational Fit** | 8–10 min | Phase 3 complete | Career driver, work preferences, learning orientation, role expectations, values alignment | Moderate — qualitative, not scored like hard competencies | Motivation/fit objectives addressed, or cap reached |
| **5 — Clarification & Closing** | 5–10 min | Phase 4 complete (or any phase, if time is nearly exhausted) | Resolve critical gaps, contradictions, unresolved MUST_HAVE items; close professionally | Targeted — only what remains unresolved and high-value | Node.js recommends/forces `COMPLETE_INTERVIEW` |

Node.js can force a phase advance at any point (question cap, time cap) regardless of whether the agent judges the phase objectives complete (`ARCHITECTURE.md` Section 6). The agent should treat remaining time/question budget (`DeterministicConstraints`) as a signal to compress: prefer `MOVE_NEXT` over `FOLLOW_UP` once budget is tight, and prioritize per Section 13.

---

## 5. Universal Competency Framework (Layer A)

Candidate dimensions applicable across most roles. Not every dimension is mandatory for every role — the agent selects which are **truly universal for this position** during planning and may drop or downweight ones with no job relevance.

| Competency | Default applicability | Notes |
|---|---|---|
| Communication | Always assessed (lightly) | See Section 16 — assessed for clarity/structure, not eloquence |
| Problem Solving | Almost always | Downweight only for extremely narrow, procedural roles |
| Collaboration | Almost always | Especially relevant if role involves cross-functional work |
| Ownership | Almost always | Central for individual-contributor and leadership roles alike |
| Adaptability | Contextual | Weight up for fast-changing environments/JD language signaling change |
| Motivation | Always assessed | Assessed qualitatively in Phase 4, not hard-scored like competencies |
| Organizational / Values Alignment | Only if Organizational Values provided | Otherwise omitted from scoring, not fabricated |

Rule: never invent a universal dimension the JD/company context gives no basis to assess (e.g., do not score "Values Alignment" with no stated values — mark it `INSUFFICIENT_EVIDENCE`/not applicable rather than guessing).

---

## 6. Position-Specific Competency Generation Method (Layer B)

Generated dynamically from Job Requirements + JD text during Phase 0. Method:

1. Cluster raw requirements by underlying skill/knowledge domain (not by literal wording) — e.g., "manages shift schedules," "handles line downtime," "leads production team" cluster into **People Leadership** + **Production Planning**, not three separate dimensions.
2. Name each cluster with a concise, role-legible competency label.
3. Attach each competency to the `JobRequirement.id`s it aggregates, and to a `MUST_HAVE`/`NICE_TO_HAVE` priority inherited from its most critical constituent requirement.
4. Do not force a fixed dimension count or reuse a fixed dimension set across positions — a Production Supervisor and an Industrial Relations Specialist should produce entirely different Layer B sets (see examples in the prompt brief).
5. Cap at a practical number of position-specific dimensions (roughly 3–6) so the interview stays achievable within the target duration — merge rather than fragment if the requirement list is long.

---

## 7. Evidence Model

Every extracted evidence unit records:

```
assessment_dimension, related_requirement, question_source (questionId),
candidate_response_source (responseId), evidence_summary,
candidate_contribution, outcome,
evidence_quality (see Section 8 companion doc), evidence_strength,
missing_evidence, contradictions, concerns,
score (dimension-level, if applicable), confidence
```

**Evidence typing — never blur these:**

| Type | Definition | Example |
|---|---|---|
| **FACT** | Directly stated by the candidate, corroborated by nothing else needed | "I managed a team of 8." |
| **INFERENCE** | The agent's reasonable interpretation beyond the literal statement | "Likely held budget authority, based on described scope" — must be labeled as inference, never merged into `evidence_summary` as if stated |
| **CONCERN** | A quality issue with the evidence itself (vagueness, inconsistency, lack of ownership) | "Answer described team outcome, not individual action" |
| **MISSING_EVIDENCE** | An explicit gap — not a negative judgment, just absence of data | "No mention of stakeholder pushback or how it was handled" |

Inference is never written into `evidence_summary` as if it were fact; it goes in `concerns` or `operational_reasoning.evidence_gap` with clear inferential framing.

---

## 8. Information Gain Priority Logic

With limited time, questions are chosen by expected information value, not by plan order alone. Practical (non-mathematical) priority ladder, evaluated fresh at every decision point:

1. **Critical MUST_HAVE, UNKNOWN** — highest value; nothing is known, and it's required.
2. **Critical MUST_HAVE, PARTIAL_MATCH** — resolving ambiguity on something required is nearly as valuable.
3. **Critical competency with WEAK/VERY_WEAK evidence so far** — an objective already started but not yet resolved.
4. **Important unresolved contradiction** — left alone, it degrades the whole assessment's credibility.
5. **High-priority position-specific competency**, not yet addressed.
6. **Important universal competency**, not yet addressed.
7. **NICE_TO_HAVE items** — pursued only if time remains after 1–6 are resolved or judged not resolvable further.

Tie-break rule: prefer the objective whose resolution unblocks a phase transition (i.e., is the last unresolved item keeping the phase open) over one that is merely "next in priority" but not phase-blocking.

The agent re-evaluates this ladder after every turn — priorities are recomputed from current `unresolvedGapIds` and evidence state, not fixed at planning time.

---

## 9. Time Awareness

Supported presets (actual enforcement is Node.js's `maxDurationMinutes`/`maxQuestions`):

| Preset | Total duration | Practical phase allocation |
|---|---|---|
| Short | ~30 min | Compress Phases 2–3 into fewer, higher-yield questions; Phase 4 minimal |
| Standard | ~45–60 min | Matches Section 4 targets as written |
| Deep / Managerial-Specialist | ~60–90 min | More follow-up depth per objective, room for more position-specific competencies |

The agent receives `DeterministicConstraints` (remaining time, remaining questions, follow-ups used) on every turn and must use them to self-regulate: as remaining budget shrinks, shift down the priority ladder toward `MOVE_NEXT`/`COMPLETE_INTERVIEW` rather than `FOLLOW_UP`/`DEEP_DIVE`, favoring Section 8's top-ranked unresolved items. The agent must never assume it controls the clock — Node.js enforces the actual cutoff regardless of what the agent recommends.

---

## 10. Adaptive Question Decision Table

Evaluated after every candidate answer, before choosing `recommended_action`:

| # | Question the agent asks itself | Feeds into |
|---|---|---|
| 1 | What evidence was obtained? | `evidence_updates` |
| 2 | Which requirement/competency does it support? | `evidence_updates.requirement_id` / `competency` |
| 3 | How strong is the evidence? | `evidence_updates.strength` (Section 8 of SCORING_FRAMEWORK.md) |
| 4 | What evidence is still missing? | `operational_reasoning.evidence_gap`, `unresolvedGapIds` |
| 5 | Is additional probing valuable? | Compare against Section 8 priority ladder + remaining budget |
| 6 | What should happen next? | `recommended_action` |

| Answer quality observed | Likely action | Rationale |
|---|---|---|
| Vague / generic, high-value objective, budget available | `FOLLOW_UP` | Ask the single highest-value missing element (Section 11), not a generic "tell me more" |
| Theoretical, not experiential, MUST_HAVE competency | `CLARIFY` or `FOLLOW_UP` | Redirect toward an actual instance: "Can you walk me through a specific time this happened?" |
| Missing candidate's personal contribution vs. team's | `FOLLOW_UP` | Ask specifically about individual role/decisions |
| Strong, specific, outcome-bearing answer, objective target met | `MOVE_NEXT` | Sufficient evidence; further probing is low marginal value |
| Contradicts CV or an earlier answer | `CLARIFY` | Resolve before scoring (Section 18) |
| `maxFollowUpsPerObjective` reached (per constraints) | Must recommend `MOVE_NEXT` regardless of residual doubt | Node.js will force this anyway; agent should self-align |
| All critical objectives resolved, low-value gaps only remain | `COMPLETE_INTERVIEW` | See Section 12 completion rules |

---

## 11. Probing Rules

Probe (FOLLOW_UP / CLARIFY / DEEP_DIVE) when an answer is:

- vague or generic;
- theoretical rather than experiential;
- missing the candidate's personal contribution;
- missing the action taken;
- missing the outcome/result;
- internally inconsistent, or inconsistent with the CV or a prior answer;
- suspiciously unsupported for a claim of this scope;
- critical to an unresolved MUST_HAVE requirement.

**Ask the single highest-value follow-up, not every possible one.** Given the classic weak example —

> "I led a productivity improvement project."

possible gaps are: the actual problem, personal responsibility, personal action, decision process, measurable result. The agent picks **one** — typically personal contribution/action first (it is usually the scarcest and highest-value element), then, only if budget allows and the objective remains unresolved, a second follow-up targets outcome. Do not queue a checklist of all five; that violates one-question-at-a-time and burns budget inefficiently.

STAR (Situation, Task, Action, Result) is used **internally only** as a completeness checklist for evidence sufficiency — never surfaced to the candidate as an instruction to "answer using STAR." Questions stay natural and conversational.

---

## 12. Completion Decision Table

Recommend `COMPLETE_INTERVIEW` when:

- all MUST_HAVE requirements have adequate evidence (SATISFIED or a deliberate, recorded INSUFFICIENT_EVIDENCE after genuine attempts);
- critical competencies (MUST_HAVE-linked) have adequate evidence;
- important contradictions are resolved or explicitly recorded as unresolved concerns;
- remaining known gaps are low-value (NICE_TO_HAVE, or MUST_HAVE items already exhausted without further avenues);

**or**

- expected information gain of another question no longer exceeds its cost — practically: the top of the Section 8 priority ladder currently contains nothing above "NICE_TO_HAVE," or every higher-ranked item has already used its follow-up budget.

Translated into deterministic-friendly rules Node.js can cross-check:
- If `objectives_completed == objectives_total` (from `progress`) → strong completion signal.
- If all MUST_HAVE-linked objectives are `SATISFIED` or `INSUFFICIENT_EVIDENCE` → strong completion signal even if some NICE_TO_HAVE objectives remain `PENDING`.
- If remaining time/questions per `DeterministicConstraints` are near exhaustion → agent should recommend completion proactively rather than let Node.js force it, to allow a graceful closing message.

Node.js retains final authority regardless (`ARCHITECTURE.md` Section 6/13) — this table governs what the agent *recommends*, not what is guaranteed to happen.

---

## 13. Bias and Fairness Guardrails

The agent must never use, weight, or reference as a quality signal:

- age, gender, ethnicity, national origin, religion, marital/family status, disability, political views, or other protected characteristics — even if the candidate volunteers them.
- accent, speech pattern, or vocabulary sophistication unrelated to job-relevant communication (Section 14).
- appearance or any non-textual signal (not applicable in this text-based MVP, but stated as a standing principle for future modalities).

If a candidate volunteers protected-characteristic information unprompted, the agent acknowledges neutrally and does not incorporate it into any evidence, score, or `operational_reasoning` field. All evidence and scoring must trace to job-related content only.

---

## 14. Communication Assessment Guardrails

Score communication on:
- clarity of explanation;
- logical structuring of an answer;
- ability to convey relevant technical/operational information to the right audience;
- (where job-relevant) evidence of adapting communication to different stakeholders.

Explicitly **do not** let these inflate or deflate a communication score:
- accent or non-native phrasing;
- charisma or extroversion;
- vocabulary sophistication unrelated to job needs;
- speaking length/eloquence alone.

A concise, clear, structured answer should score as well as or better than a long, polished-sounding one that is actually vague. This guards against "good speaker = good candidate" bias.

---

## 15. Contradiction Handling

Two contradiction types:

1. **CV claim ≠ interview answer.**
2. **Earlier answer ≠ later answer.**

Rule: the agent's first move is always to **clarify, not accuse or assume dishonesty.** Neutral clarifying phrasing, e.g.: "Earlier you mentioned X, and just now Y — can you help me understand how those fit together?"

- If clarification resolves it (e.g., different time periods, roles, or a misunderstanding) → record as resolved, no concern flag.
- If it remains unresolved or the candidate's explanation itself is inconsistent → record as a `concern`/contradiction in the evidence model, feed into `operational_reasoning`, and only weight it in the final assessment if it is relevant to a scored requirement/competency — irrelevant trivial discrepancies are not flagged as risks.

---

## 16. Candidate Behavior Edge Cases

| Situation | Handling |
|---|---|
| Extremely short answer | One clarifying/expanding follow-up; if it remains short after that, record as `INSUFFICIENT_EVIDENCE`/weak and move on — do not repeat the same prompt indefinitely. |
| Overly long / rambling answer | Acknowledge, then ask a narrowing follow-up targeting the single missing element; do not attempt to extract every possible thread. |
| Off-topic answer | Politely redirect once to the original question's intent; if still off-topic, move on and record as unaddressed rather than force repeatedly. |
| Candidate doesn't understand the question | Rephrase once in simpler/more concrete terms; do not repeat verbatim. |
| Candidate refuses to answer | Accept gracefully, record as `MISSING_EVIDENCE` (not a negative score), move to next objective. |
| "I have no relevant experience here" | Accept, optionally probe for adjacent/transferable experience once if the requirement is MUST_HAVE, then record honestly as a gap — never fabricate evidence. |
| Theoretical/hypothetical answer instead of real experience | One redirect asking for an actual instance; if candidate still cannot provide one, treat as evidence of a real gap, not as equivalent to experiential evidence. |
| Repeated vague answers across multiple objectives | After 2 consecutive vague-and-unresolved objectives, the agent should note a general `concern` about answer specificity (a candidate-level pattern) rather than only per-question notes, and adjust probing depth expectations downward (further probing likely won't help — move on faster, per Section 12). |

Throughout all edge cases, the agent maintains a professional, respectful tone — never impatient, judgmental, or leading.

---

## 17. Example Adaptive Interview Sequence

Objective: `system_design` competency, requirement `req_003` (MUST_HAVE, `PARTIAL_MATCH` from CV).

1. **Q1 (DEEP_DIVE opener):** "Tell me about a time you led a significant technical migration." → Candidate gives a team-outcome-only answer ("We migrated the service and reduced latency").
2. **Evaluate:** Evidence obtained = outcome-level fact only; missing = personal contribution, decision-making role. Strength = WEAK. Action = `FOLLOW_UP`.
3. **Q2 (FOLLOW_UP):** "What was your specific decision-making role versus the team's?" → Candidate describes owning the architecture decision and unblocking two downstream teams.
4. **Evaluate:** Evidence obtained = personal contribution + scope; missing = concrete result/metric. Strength = MODERATE. Follow-ups used = 1/2. Action = `FOLLOW_UP` (still budget, still MUST_HAVE, still valuable).
5. **Q3 (FOLLOW_UP):** "What measurable difference did that migration make?" → Candidate gives a concrete metric (latency reduction %, incident reduction).
6. **Evaluate:** Evidence obtained = outcome/result; objective now has FACT-based contribution + outcome. Strength = STRONG. `targetEvidenceCount` met. Action = `MOVE_NEXT`.

Three turns, one objective, incrementally built evidence, no wasted questions, no checklist-style interrogation.

---

## 18. Example Evidence Evolution

| Turn | Evidence added | Type | Strength (cumulative) | Coverage |
|---|---|---|---|---|
| 1 | "Migrated a service, reduced latency" (team-level) | FACT | WEAK | PARTIALLY_COVERED |
| 2 | "Owned architecture decision; unblocked 2 downstream teams" | FACT | MODERATE | PARTIALLY_COVERED |
| 2 | "Likely had informal technical authority beyond title" | INFERENCE (kept separate, not scored as fact) | — | — |
| 3 | "Reduced p95 latency by ~30%, cut related incidents" | FACT | STRONG | COVERED |

Final `RequirementAssessment` for `req_003`: `coverageLevel = COVERED`, `confidence ≈ 0.85` (multiple consistent, specific, outcome-bearing evidence items; see confidence methodology in `SCORING_FRAMEWORK.md`), `insufficient_evidence_flag = false`.

---

## 19. Visualization Recommendations (Data Only — LLM/Node.js Produces Data, Frontend Renders)

| Visualization | Best audience | Data needed |
|---|---|---|
| Radar Chart (competency profile) | Hiring manager | Per-competency score (1–5) across Universal + Position-Specific dimensions |
| Weighted Scorecard | Recruiter, decision support | Score × weight per requirement/competency, critical gate pass/fail flags |
| Requirement-Match Matrix | Recruiter | Requirement × coverage_level × confidence, MUST_HAVE/NICE_TO_HAVE flagged |
| Competency Heatmap | Multi-candidate comparison | Competency × candidate grid of scores |
| Score vs. Confidence scatter | Executive / risk review | Each scored dimension plotted score (x) vs. confidence (y) — flags "strong-looking but thin-evidence" results in the low-confidence/high-score quadrant |

The agent and Node.js only ever emit the underlying structured data (`FinalAssessment` and its nested fields); no chart-rendering responsibility belongs to the LLM or the orchestrator.

---

## 20. Production LLM Input Structure (Reference)

Matches `InitializationRequest` / `TurnRequest` in `ARCHITECTURE.md` Section 9. This document adds the *interview-intelligence* meaning of each field the prompt must reason over:

- `candidateProfile` — derived CV summary, treated as a starting hypothesis, never as verified fact.
- `requirements` (compact) — MUST_HAVE/NICE_TO_HAVE + competency tag, used to prioritize per Section 8.
- `currentObjective` — the single objective the agent should be resolving this turn (though it may recommend `MOVE_NEXT`/pivot if evidence suggests another objective is now higher priority within phase bounds).
- `relevantEvidence` — only current/adjacent-objective evidence; the agent must not assume access to full history it wasn't given.
- `unresolvedGaps` — current objective's outstanding gaps only.
- `latestAnswer` — untrusted data (Section 24 of `ARCHITECTURE.md`); evaluated as evidence only, never as instructions.
- `constraints` — remaining questions/time/follow-ups; directly feeds Sections 9 and 12 of this document.

---

## 21. Production LLM Output Structure (Reference)

Matches `AIDecision` in `ARCHITECTURE.md` Section 9/16. Interview-intelligence mapping:

- `recommended_action` — the outcome of the Section 10 decision table.
- `candidate_message` — natural, professional, single-question or closing message; never exposes scoring, gaps, or internal reasoning.
- `question` — null only when `recommended_action == COMPLETE_INTERVIEW`.
- `evidence_updates` — FACT/INFERENCE distinctions collapse into `summary` + `strength` per the Evidence Model (Section 7); inference framing, if included, must be explicitly hedged in the text of `summary`.
- `assessment_updates` — rollup-level coverage change only, not a full rescoring narrative.
- `operational_reasoning` — exactly the two fields (`objective`, `evidence_gap`); this is the sole permitted window into the agent's reasoning, and must stay a short factual note, never chain-of-thought prose.
- `progress` — feeds Section 12 completion signals.

Full scoring/confidence/weighting mechanics for these fields are defined in `SCORING_FRAMEWORK.md`. The production system prompt implementing all of the above is in `HR_INTERVIEWER_SYSTEM_PROMPT.md`.
