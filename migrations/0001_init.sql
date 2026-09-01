-- 0001_init.sql — MVP schema.
-- Authority: API_CONTRACT.md v3 + CONTRACT_ADDENDUM_v3.1.md.
--
-- Enum strategy: CHECK constraints over TEXT rather than native PG enum types.
-- Adding a value to a native enum is a DDL migration that cannot run inside some
-- transaction contexts, and the closed sets here are already enforced by Ajv and
-- the domain layer; the CHECK is the storage-layer backstop, not the primary gate.

-- schema_migrations is owned and created by the migration runner.

-- ---------------------------------------------------------------- reference data

CREATE TABLE candidates (
  id                      TEXT PRIMARY KEY,
  full_name               TEXT NOT NULL,
  -- Encrypted at rest (ARCHITECTURE.md §23). bytea so the mapper owns the cipher.
  cv_raw_text_encrypted   BYTEA,
  cv_structured_summary   JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE positions (
  id                      TEXT PRIMARY KEY,
  title                   TEXT NOT NULL,
  job_description         TEXT NOT NULL,
  company_context         TEXT,
  organizational_values   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_requirements (
  id               TEXT PRIMARY KEY,
  position_id      TEXT NOT NULL REFERENCES positions(id),
  label            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  priority         TEXT NOT NULL CHECK (priority IN ('MUST_HAVE','NICE_TO_HAVE')),
  competency_tag   TEXT NOT NULL,
  recruiter_weight NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  -- B1: the only gate designation in the system. Never AI-visible, never derived
  -- from priority.
  critical_gate    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_requirements_position_idx ON job_requirements(position_id);

-- Deferred per SCORING_FRAMEWORK.md v3 §5.1: absence of a row must never block
-- scoring, since the 1.0 default always applies cleanly.
CREATE TABLE position_competency_weights (
  position_id    TEXT NOT NULL REFERENCES positions(id),
  competency_tag TEXT NOT NULL,
  weight         NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  PRIMARY KEY (position_id, competency_tag)
);

-- ---------------------------------------------------------------- interview core

CREATE TABLE interviews (
  id                                   TEXT PRIMARY KEY,
  candidate_id                         TEXT NOT NULL REFERENCES candidates(id),
  position_id                          TEXT NOT NULL REFERENCES positions(id),
  status                               TEXT NOT NULL CHECK (status IN (
                                         'INITIALIZING','PRE_INTERVIEW_ANALYSIS','OPENING',
                                         'EXPERIENCE_VALIDATION','COMPETENCY_DEEP_DIVE',
                                         'MOTIVATION_FIT','CLARIFICATION','CLOSING',
                                         'COMPLETED','TERMINATED','ERROR')),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- B4: set once, at the first Question.presented_at. Never equal to created_at
  -- if any planning delay occurred.
  started_at                           TIMESTAMPTZ,
  updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at                         TIMESTAMPTZ,
  terminated_reason                    TEXT CHECK (terminated_reason IN (
                                         'SESSION_IDLE_EXPIRED','MAX_DURATION_EXCEEDED',
                                         'MAX_QUESTIONS_EXCEEDED','RECRUITER_TERMINATED')),
  -- B4: bounds ACTIVE interview time, never wall-clock since created_at.
  max_duration_minutes                 INTEGER NOT NULL,
  max_questions                        INTEGER NOT NULL,
  max_follow_ups_per_objective         INTEGER NOT NULL,
  max_candidate_response_window_seconds INTEGER NOT NULL,
  session_idle_timeout_minutes         INTEGER NOT NULL
);
CREATE INDEX interviews_candidate_idx ON interviews(candidate_id);
CREATE INDEX interviews_status_idx ON interviews(status);

CREATE TABLE interview_plans (
  interview_id TEXT NOT NULL REFERENCES interviews(id),
  version      INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (interview_id, version)
);

-- Objectives are relational rather than JSONB: questions, evidence and gaps all
-- carry foreign keys to them, which is what preserves the §25 traceability chain.
CREATE TABLE interview_objectives (
  id                    TEXT PRIMARY KEY,
  interview_id          TEXT NOT NULL REFERENCES interviews(id),
  plan_version          INTEGER NOT NULL DEFAULT 1,
  -- C2: the AI's response-local ref, retained as a debug label only. Never
  -- authoritative, never referenced by another table.
  ai_ref                TEXT NOT NULL,
  phase                 TEXT NOT NULL CHECK (phase IN (
                          'OPENING','EXPERIENCE_VALIDATION','COMPETENCY_DEEP_DIVE',
                          'MOTIVATION_FIT','CLARIFICATION','CLOSING')),
  competency_tag        TEXT NOT NULL,
  competency_layer      TEXT NOT NULL CHECK (competency_layer IN ('UNIVERSAL','POSITION_SPECIFIC')),
  target_evidence_count INTEGER NOT NULL,
  ordinal               INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'PENDING','IN_PROGRESS','SATISFIED','INSUFFICIENT_EVIDENCE')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Refs are unique within one plan; this is the constraint behind the C2
  -- duplicate-ref validation.
  UNIQUE (interview_id, plan_version, ai_ref)
);
CREATE INDEX interview_objectives_interview_idx ON interview_objectives(interview_id);

CREATE TABLE interview_objective_requirements (
  objective_id   TEXT NOT NULL REFERENCES interview_objectives(id),
  requirement_id TEXT NOT NULL REFERENCES job_requirements(id),
  PRIMARY KEY (objective_id, requirement_id)
);

CREATE TABLE interview_state (
  interview_id                    TEXT PRIMARY KEY REFERENCES interviews(id),
  current_phase                   TEXT NOT NULL,
  current_objective_id            TEXT REFERENCES interview_objectives(id),
  questions_asked_count           INTEGER NOT NULL DEFAULT 0,
  follow_ups_by_objective         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- B4: two independent clocks. elapsed_active accumulates clamped turn time;
  -- last_activity_at drives only the idle guardrail.
  elapsed_active_interview_seconds INTEGER NOT NULL DEFAULT 0,
  phase_elapsed_seconds           JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_activity_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  unresolved_gap_ids              JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_question_id                TEXT,
  -- Optimistic concurrency: every write carries WHERE version = :expected.
  version                         INTEGER NOT NULL DEFAULT 0,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id              TEXT PRIMARY KEY,
  interview_id    TEXT NOT NULL REFERENCES interviews(id),
  objective_id    TEXT NOT NULL REFERENCES interview_objectives(id),
  phase           TEXT NOT NULL,
  text            TEXT NOT NULL,
  -- B4: the turn's clock start.
  presented_at    TIMESTAMPTZ NOT NULL,
  -- A1: restored. This constraint is what makes a double-applied turn impossible
  -- at the storage layer rather than merely unlikely.
  sequence_number INTEGER NOT NULL,
  competency_tag  TEXT,
  question_type   TEXT NOT NULL,
  CONSTRAINT questions_interview_sequence_unique UNIQUE (interview_id, sequence_number)
);
CREATE INDEX questions_interview_seq_idx ON questions(interview_id, sequence_number);
CREATE INDEX questions_objective_idx ON questions(objective_id);

CREATE TABLE candidate_responses (
  id                  TEXT PRIMARY KEY,
  question_id         TEXT NOT NULL REFERENCES questions(id),
  interview_id        TEXT NOT NULL REFERENCES interviews(id),
  answer_text_encrypted BYTEA NOT NULL,
  -- B4: closes turn_active_seconds. Set at the durable pre-LLM-call write.
  received_at         TIMESTAMPTZ NOT NULL,
  -- One answer per question: the turn pipeline resumes rather than inserting twice.
  CONSTRAINT candidate_responses_question_unique UNIQUE (question_id)
);
CREATE INDEX candidate_responses_interview_idx ON candidate_responses(interview_id);

CREATE TABLE evidence (
  id                 TEXT PRIMARY KEY,
  interview_id       TEXT NOT NULL REFERENCES interviews(id),
  requirement_id     TEXT REFERENCES job_requirements(id),
  competency_tag     TEXT NOT NULL,
  -- Never trusted from AI output; set from the current turn's response.
  source_response_id TEXT NOT NULL REFERENCES candidate_responses(id),
  objective_id       TEXT REFERENCES interview_objectives(id),
  summary            TEXT NOT NULL,
  strength           TEXT NOT NULL CHECK (strength IN (
                       'VERY_WEAK','WEAK','MODERATE','STRONG','VERY_STRONG','INSUFFICIENT')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evidence_interview_idx ON evidence(interview_id);
CREATE INDEX evidence_requirement_idx ON evidence(interview_id, requirement_id);
CREATE INDEX evidence_competency_idx ON evidence(interview_id, competency_tag);

CREATE TABLE evidence_gaps (
  id            TEXT PRIMARY KEY,
  interview_id  TEXT NOT NULL REFERENCES interviews(id),
  objective_id  TEXT NOT NULL REFERENCES interview_objectives(id),
  gap_type      TEXT NOT NULL CHECK (gap_type IN (
                  'CONTEXT','RESPONSIBILITY','PERSONAL_CONTRIBUTION','ACTION','RESULT',
                  'MEASURABLE_OUTCOME','TECHNICAL_DEPTH','DECISION_RATIONALE',
                  'CONTRADICTION','OTHER')),
  -- A5: Node-derived class. The AI has no field to declare a gap blocking.
  gap_class     TEXT NOT NULL CHECK (gap_class IN ('BLOCKING','ADVISORY')),
  description   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);
-- C11: identity is (objectiveId, gapType). The partial unique index IS the dedup
-- rule — at most one OPEN gap per pair, enforced by the database rather than by
-- application care, and needing no text similarity matching.
CREATE UNIQUE INDEX evidence_gaps_open_unique
  ON evidence_gaps(objective_id, gap_type) WHERE status = 'OPEN';
CREATE INDEX evidence_gaps_interview_idx ON evidence_gaps(interview_id);

-- ---------------------------------------------------------------- assessments

CREATE TABLE requirement_assessments (
  interview_id              TEXT NOT NULL REFERENCES interviews(id),
  requirement_id            TEXT NOT NULL REFERENCES job_requirements(id),
  coverage_level            TEXT NOT NULL CHECK (coverage_level IN (
                              'COVERED','PARTIALLY_COVERED','NOT_COVERED')),
  score                     INTEGER,
  confidence_band           TEXT NOT NULL CHECK (confidence_band IN (
                              'VERY_LOW','LOW','MODERATE','HIGH','VERY_HIGH')),
  confidence_score          NUMERIC(4,3) NOT NULL DEFAULT 0,
  insufficient_evidence_flag BOOLEAN NOT NULL DEFAULT FALSE,
  -- B1: the only place gate status is computed at the item level.
  gate_status               TEXT NOT NULL DEFAULT 'NOT_A_GATE' CHECK (gate_status IN (
                              'NOT_A_GATE','CLEARED','FAILED','INSUFFICIENT_DATA')),
  notes                     TEXT NOT NULL DEFAULT '',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (interview_id, requirement_id)
);

-- B1: carries NO gate columns. is_critical_gate and gate_status are absent by
-- design, not defaulted — a competency can never be a gate in MVP.
CREATE TABLE competency_assessments (
  interview_id     TEXT NOT NULL REFERENCES interviews(id),
  competency_tag   TEXT NOT NULL,
  competency_layer TEXT NOT NULL CHECK (competency_layer IN ('UNIVERSAL','POSITION_SPECIFIC')),
  coverage_level   TEXT NOT NULL CHECK (coverage_level IN (
                     'COVERED','PARTIALLY_COVERED','NOT_COVERED')),
  rating           TEXT CHECK (rating IN ('STRONG','ADEQUATE','WEAK','INSUFFICIENT_EVIDENCE')),
  score            INTEGER,
  confidence_band  TEXT NOT NULL CHECK (confidence_band IN (
                     'VERY_LOW','LOW','MODERATE','HIGH','VERY_HIGH')),
  confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0,
  weight           NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  rationale        TEXT NOT NULL DEFAULT '',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (interview_id, competency_tag)
);

CREATE TABLE final_assessments (
  interview_id               TEXT PRIMARY KEY REFERENCES interviews(id),
  -- B6: so a later recalibration never silently reinterprets a historical result.
  scoring_config_version     TEXT NOT NULL,
  competency_score           NUMERIC(4,2),
  competency_confidence_band TEXT NOT NULL,
  -- B2: renamed from must_have_gate_status; critical-gate requirements only.
  critical_gate_status       TEXT NOT NULL CHECK (critical_gate_status IN (
                               'ALL_CLEARED','ONE_OR_MORE_FAILED','ONE_OR_MORE_INSUFFICIENT')),
  overall_recommendation     TEXT NOT NULL CHECK (overall_recommendation IN (
                               'STRONGLY_RECOMMENDED','RECOMMENDED','CONSIDER',
                               'NOT_RECOMMENDED','INSUFFICIENT_DATA')),
  overall_confidence_band    TEXT NOT NULL,
  key_strengths              JSONB NOT NULL DEFAULT '[]'::jsonb,
  concerns                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  unverified_areas           JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradictions             JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_flags                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  nice_to_have_highlights    JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation_rationale   TEXT NOT NULL DEFAULT '',
  generated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  human_override             JSONB
);

-- ---------------------------------------------------------------- audit & operations

CREATE TABLE audit_events (
  id           BIGSERIAL PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'STATE_TRANSITION','AI_CALL','VALIDATION_FAILURE',
                 'GUARDRAIL_OVERRIDE','HUMAN_OVERRIDE','ERROR')),
  rule         TEXT,
  -- Structured metadata only — never raw chain-of-thought (ARCHITECTURE.md §25).
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_interview_idx ON audit_events(interview_id, created_at);

-- C10/C12/C13 + B3. One table represents both the retry state machine and the
-- cached successful result; a separate turn_results table was rejected as a
-- second source of truth that must be kept consistent.
CREATE TABLE turn_operations (
  id                          TEXT PRIMARY KEY,
  scope                       TEXT NOT NULL CHECK (scope IN ('interview_create','interview_response')),
  idempotency_key             TEXT NOT NULL,
  -- A replayed key with a different body is a client error, never silently reused.
  request_hash                TEXT NOT NULL,
  interview_id                TEXT REFERENCES interviews(id),
  question_id                 TEXT REFERENCES questions(id),
  status                      TEXT NOT NULL CHECK (status IN (
                                'PROCESSING','SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL')),
  attempt_count               INTEGER NOT NULL DEFAULT 1,
  -- B3: PROCESSING is a lease, not a latch. An expired lease is reclaimable, so a
  -- crashed process cannot wedge the interview at 409 forever.
  processing_started_at       TIMESTAMPTZ,
  processing_lease_expires_at TIMESTAMPTZ,
  response_status             INTEGER,
  response_body               JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                  TIMESTAMPTZ NOT NULL
);
-- API_CONTRACT.md v3 §5: composite uniqueness differs by scope.
CREATE UNIQUE INDEX turn_operations_create_key
  ON turn_operations(scope, idempotency_key) WHERE scope = 'interview_create';
CREATE UNIQUE INDEX turn_operations_response_key
  ON turn_operations(scope, interview_id, question_id, idempotency_key)
  WHERE scope = 'interview_response';
