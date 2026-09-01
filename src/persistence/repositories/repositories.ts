/**
 * Postgres repository adapters.
 *
 * Hand-written SQL: the transaction and operation boundaries in the contracts are
 * precise enough that an ORM's implicit unit of work would be a liability.
 * Nothing above this layer imports `pg`.
 */
import type pg from 'pg';
import { exec } from '../db/pool.ts';
import type { FieldCipher } from '../crypto/fieldCipher.ts';
import { classifyGap } from '../../domain/gaps/classification.ts';
import type { GapIntent } from '../../domain/gaps/reconcile.ts';
import { asObjectiveId } from '../../domain/types/entities.ts';
import type {
  CandidateResponse,
  Evidence,
  EvidenceGap,
  Interview,
  InterviewObjective,
  InterviewState,
  ObjectiveId,
  Question,
} from '../../domain/types/entities.ts';
import type {
  CoverageLevel,
  EvidenceStrength,
  InterviewPhase,
  InterviewStatus,
  ObjectiveStatus,
} from '../../domain/types/enums.ts';
import type { AuditIntent } from '../../domain/audit/auditIntent.ts';
import type * as P from '../../application/ports/ports.ts';

const iso = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString());

// ------------------------------------------------------------------ interviews

export class PgInterviewRepository implements P.InterviewRepository {
  constructor(private readonly pool: pg.Pool) {}

  async load(interviewId: string, tx?: P.TxScope): Promise<Interview | null> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT * FROM interviews WHERE id = $1`,
      [interviewId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      candidateId: r.candidate_id,
      positionId: r.position_id,
      status: r.status as InterviewStatus,
      createdAt: iso(r.created_at),
      ...(r.started_at ? { startedAt: iso(r.started_at) } : {}),
      updatedAt: iso(r.updated_at),
      ...(r.completed_at ? { completedAt: iso(r.completed_at) } : {}),
      ...(r.terminated_reason ? { terminatedReason: r.terminated_reason } : {}),
      maxDurationMinutes: r.max_duration_minutes,
      maxQuestions: r.max_questions,
      maxFollowUpsPerObjective: r.max_follow_ups_per_objective,
      maxCandidateResponseWindowSeconds: r.max_candidate_response_window_seconds,
      sessionIdleTimeoutMinutes: r.session_idle_timeout_minutes,
    };
  }

  async insert(i: Interview, tx?: P.TxScope): Promise<void> {
    await exec(this.pool, tx).query(
      `INSERT INTO interviews (id, candidate_id, position_id, status, created_at, updated_at,
         max_duration_minutes, max_questions, max_follow_ups_per_objective,
         max_candidate_response_window_seconds, session_idle_timeout_minutes)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10)`,
      [
        i.id, i.candidateId, i.positionId, i.status, i.createdAt,
        i.maxDurationMinutes, i.maxQuestions, i.maxFollowUpsPerObjective,
        i.maxCandidateResponseWindowSeconds, i.sessionIdleTimeoutMinutes,
      ],
    );
  }

  /** Sets startedAt exactly once — B4 requires it to anchor the first question. */
  async markStarted(interviewId: string, status: InterviewStatus, startedAt: string, tx: P.TxScope): Promise<void> {
    await exec(this.pool, tx).query(
      `UPDATE interviews SET status = $2, started_at = COALESCE(started_at, $3), updated_at = $3
       WHERE id = $1`,
      [interviewId, status, startedAt],
    );
  }

  async setStatus(interviewId: string, status: InterviewStatus, at: string, tx?: P.TxScope): Promise<void> {
    await exec(this.pool, tx).query(
      `UPDATE interviews SET status = $2, updated_at = $3,
         completed_at = CASE WHEN $2 = 'COMPLETED' THEN $3 ELSE completed_at END
       WHERE id = $1`,
      [interviewId, status, at],
    );
  }
}

// --------------------------------------------------------------- reference data

export class PgReferenceRepository {
  constructor(private readonly pool: pg.Pool, private readonly cipher: FieldCipher) {}

  async insertCandidate(
    c: { id: string; fullName: string; cvRawText: string; createdAt: string },
    tx?: P.TxScope,
  ): Promise<void> {
    await exec(this.pool, tx).query(
      `INSERT INTO candidates (id, full_name, cv_raw_text_encrypted, created_at) VALUES ($1,$2,$3,$4)`,
      [c.id, c.fullName, this.cipher.encrypt(c.cvRawText), c.createdAt],
    );
  }

  async insertPosition(
    p: {
      id: string; title: string; jobDescription: string;
      companyContext?: string | undefined; organizationalValues?: string | undefined; createdAt: string;
    },
    tx?: P.TxScope,
  ): Promise<void> {
    await exec(this.pool, tx).query(
      `INSERT INTO positions (id, title, job_description, company_context, organizational_values, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [p.id, p.title, p.jobDescription, p.companyContext ?? null, p.organizationalValues ?? null, p.createdAt],
    );
  }

  async insertRequirements(
    positionId: string,
    reqs: ReadonlyArray<{
      id: string; label: string; description: string;
      priority: 'MUST_HAVE' | 'NICE_TO_HAVE'; competencyTag: string; criticalGate: boolean;
    }>,
    tx?: P.TxScope,
  ): Promise<void> {
    for (const r of reqs) {
      await exec(this.pool, tx).query(
        `INSERT INTO job_requirements (id, position_id, label, description, priority, competency_tag, critical_gate)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.id, positionId, r.label, r.description, r.priority, r.competencyTag, r.criticalGate],
      );
    }
  }

  async requirementsForInterview(interviewId: string, tx?: P.TxScope) {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT jr.* FROM job_requirements jr
        JOIN interviews i ON i.position_id = jr.position_id
       WHERE i.id = $1 ORDER BY jr.id`,
      [interviewId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      positionId: r.position_id as string,
      label: r.label as string,
      description: r.description as string,
      priority: r.priority as 'MUST_HAVE' | 'NICE_TO_HAVE',
      competencyTag: r.competency_tag as string,
      recruiterWeight: Number(r.recruiter_weight),
      criticalGate: r.critical_gate as boolean,
    }));
  }
}

// ------------------------------------------------------------- interview state

export class PgInterviewStateRepository implements P.InterviewStateRepository {
  constructor(private readonly pool: pg.Pool) {}

  async load(interviewId: string, tx?: P.TxScope): Promise<InterviewState | null> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT * FROM interview_state WHERE interview_id = $1`,
      [interviewId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      interviewId: r.interview_id,
      currentPhase: r.current_phase as InterviewStatus,
      currentObjectiveId: r.current_objective_id ? asObjectiveId(r.current_objective_id) : null,
      questionsAskedCount: r.questions_asked_count,
      followUpsByObjective: r.follow_ups_by_objective ?? {},
      elapsedActiveInterviewSeconds: r.elapsed_active_interview_seconds,
      phaseElapsedSeconds: r.phase_elapsed_seconds ?? {},
      lastActivityAt: iso(r.last_activity_at),
      unresolvedGapIds: r.unresolved_gap_ids ?? [],
      lastQuestionId: r.last_question_id,
      version: r.version,
      updatedAt: iso(r.updated_at),
    };
  }

  async insert(s: InterviewState, tx: P.TxScope): Promise<void> {
    await exec(this.pool, tx).query(
      `INSERT INTO interview_state (interview_id, current_phase, current_objective_id,
         questions_asked_count, follow_ups_by_objective, elapsed_active_interview_seconds,
         phase_elapsed_seconds, last_activity_at, unresolved_gap_ids, last_question_id,
         version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        s.interviewId, s.currentPhase, s.currentObjectiveId, s.questionsAskedCount,
        JSON.stringify(s.followUpsByObjective), s.elapsedActiveInterviewSeconds,
        JSON.stringify(s.phaseElapsedSeconds), s.lastActivityAt,
        JSON.stringify(s.unresolvedGapIds), s.lastQuestionId, s.version, s.updatedAt,
      ],
    );
  }

  /**
   * Optimistic concurrency. A zero row count means a concurrent turn already
   * advanced the state; the caller surfaces 409 rather than overwriting it.
   */
  async compareAndSwap(next: InterviewState, expectedVersion: number, tx: P.TxScope): Promise<boolean> {
    const { rowCount } = await exec(this.pool, tx).query(
      `UPDATE interview_state SET current_phase = $2, current_objective_id = $3,
         questions_asked_count = $4, follow_ups_by_objective = $5,
         elapsed_active_interview_seconds = $6, phase_elapsed_seconds = $7,
         last_activity_at = $8, unresolved_gap_ids = $9, last_question_id = $10,
         version = $11, updated_at = $12
       WHERE interview_id = $1 AND version = $13`,
      [
        next.interviewId, next.currentPhase, next.currentObjectiveId, next.questionsAskedCount,
        JSON.stringify(next.followUpsByObjective), next.elapsedActiveInterviewSeconds,
        JSON.stringify(next.phaseElapsedSeconds), next.lastActivityAt,
        JSON.stringify(next.unresolvedGapIds), next.lastQuestionId, next.version,
        next.updatedAt, expectedVersion,
      ],
    );
    return (rowCount ?? 0) === 1;
  }
}

// ------------------------------------------------------------------- plan

export class PgPlanRepository implements P.PlanRepository {
  constructor(private readonly pool: pg.Pool) {}

  async objectives(interviewId: string, tx?: P.TxScope): Promise<InterviewObjective[]> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT o.*, COALESCE(
           (SELECT json_agg(r.requirement_id ORDER BY r.requirement_id)
              FROM interview_objective_requirements r WHERE r.objective_id = o.id), '[]'::json
         ) AS requirement_ids
         FROM interview_objectives o WHERE o.interview_id = $1 ORDER BY o.ordinal`,
      [interviewId],
    );
    return rows.map((r) => ({
      id: asObjectiveId(r.id),
      phase: r.phase as InterviewPhase,
      requirementIds: (r.requirement_ids ?? []) as string[],
      competencyTag: r.competency_tag,
      competencyLayer: r.competency_layer,
      targetEvidenceCount: r.target_evidence_count,
      status: r.status as ObjectiveStatus,
    }));
  }

  async mustHaveObjectiveIds(interviewId: string, tx?: P.TxScope): Promise<string[]> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT DISTINCT o.id
         FROM interview_objectives o
         JOIN interview_objective_requirements oor ON oor.objective_id = o.id
         JOIN job_requirements jr ON jr.id = oor.requirement_id
        WHERE o.interview_id = $1 AND jr.priority = 'MUST_HAVE'`,
      [interviewId],
    );
    return rows.map((r) => r.id as string);
  }

  async insertPlan(interviewId: string, version: number, createdAt: string, tx: P.TxScope): Promise<void> {
    await exec(this.pool, tx).query(
      `INSERT INTO interview_plans (interview_id, version, created_at) VALUES ($1,$2,$3)`,
      [interviewId, version, createdAt],
    );
  }

  async insertObjective(
    interviewId: string,
    o: InterviewObjective & { aiRef: string; ordinal: number },
    tx: P.TxScope,
  ): Promise<void> {
    await exec(this.pool, tx).query(
      `INSERT INTO interview_objectives (id, interview_id, plan_version, ai_ref, phase,
         competency_tag, competency_layer, target_evidence_count, ordinal, status)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
      [o.id, interviewId, o.aiRef, o.phase, o.competencyTag, o.competencyLayer,
       o.targetEvidenceCount, o.ordinal, o.status],
    );
    for (const rid of o.requirementIds) {
      await exec(this.pool, tx).query(
        `INSERT INTO interview_objective_requirements (objective_id, requirement_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [o.id, rid],
      );
    }
  }

  async setObjectiveStatus(
    _interviewId: string, objectiveId: ObjectiveId, status: ObjectiveStatus, tx: P.TxScope,
  ): Promise<void> {
    await exec(this.pool, tx).query(
      `UPDATE interview_objectives SET status = $2 WHERE id = $1`, [objectiveId, status],
    );
  }
}

// ---------------------------------------------------------------- questions

export class PgQuestionRepository implements P.QuestionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async load(questionId: string, tx?: P.TxScope): Promise<Question | null> {
    const { rows } = await exec(this.pool, tx).query(`SELECT * FROM questions WHERE id = $1`, [questionId]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, interviewId: r.interview_id, objectiveId: asObjectiveId(r.objective_id),
      phase: r.phase as InterviewPhase, text: r.text, presentedAt: iso(r.presented_at),
      sequenceNumber: r.sequence_number, competencyTag: r.competency_tag, questionType: r.question_type,
    };
  }

  async insert(q: Question, tx: P.TxScope): Promise<void> {
    await exec(this.pool, tx).query(
      `INSERT INTO questions (id, interview_id, objective_id, phase, text, presented_at,
         sequence_number, competency_tag, question_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [q.id, q.interviewId, q.objectiveId, q.phase, q.text, q.presentedAt,
       q.sequenceNumber, q.competencyTag, q.questionType],
    );
  }

  async countForObjective(_i: string, objectiveId: ObjectiveId, tx?: P.TxScope): Promise<number> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT count(*)::int AS n FROM questions WHERE objective_id = $1`, [objectiveId],
    );
    return rows[0]?.n ?? 0;
  }

  async transcript(interviewId: string) {
    const { rows } = await exec(this.pool).query(
      `SELECT id, objective_id, text, sequence_number, presented_at
         FROM questions WHERE interview_id = $1 ORDER BY sequence_number`,
      [interviewId],
    );
    return rows;
  }
}

// --------------------------------------------------------- candidate responses

export class PgCandidateResponseRepository implements P.CandidateResponseRepository {
  constructor(private readonly pool: pg.Pool, private readonly cipher: FieldCipher) {}

  /** Its own short transaction: durable before the provider is ever called. */
  async insertDurable(r: CandidateResponse): Promise<void> {
    await this.pool.query(
      `INSERT INTO candidate_responses (id, question_id, interview_id, answer_text_encrypted, received_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (question_id) DO NOTHING`,
      [r.id, r.questionId, r.interviewId, this.cipher.encrypt(r.answerText), r.receivedAt],
    );
  }

  async findByQuestion(questionId: string, tx?: P.TxScope): Promise<CandidateResponse | null> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT * FROM candidate_responses WHERE question_id = $1`, [questionId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, questionId: r.question_id, interviewId: r.interview_id,
      answerText: this.cipher.decrypt(r.answer_text_encrypted), receivedAt: iso(r.received_at),
    };
  }
}

// ----------------------------------------------------------------- evidence

export class PgEvidenceRepository implements P.EvidenceRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insertMany(rows: readonly Evidence[], tx: P.TxScope): Promise<void> {
    for (const e of rows) {
      await exec(this.pool, tx).query(
        `INSERT INTO evidence (id, interview_id, requirement_id, competency_tag,
           source_response_id, objective_id, summary, strength, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [e.id, e.interviewId, e.requirementId, e.competencyTag, e.sourceResponseId,
         (e as Evidence & { objectiveId?: string }).objectiveId ?? null, e.summary, e.strength, e.createdAt],
      );
    }
  }

  async strengthsForObjective(
    interviewId: string, objective: InterviewObjective, tx?: P.TxScope,
  ): Promise<EvidenceStrength[]> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT strength FROM evidence
        WHERE interview_id = $1
          AND (competency_tag = $2 OR requirement_id = ANY($3::text[]))`,
      [interviewId, objective.competencyTag, objective.requirementIds],
    );
    return rows.map((r) => r.strength as EvidenceStrength);
  }

  async forInterview(interviewId: string, tx?: P.TxScope) {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT * FROM evidence WHERE interview_id = $1 ORDER BY created_at, id`, [interviewId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      requirementId: r.requirement_id as string | null,
      competencyTag: r.competency_tag as string,
      sourceResponseId: r.source_response_id as string,
      summary: r.summary as string,
      strength: r.strength as EvidenceStrength,
    }));
  }
}

// -------------------------------------------------------------- evidence gaps

export class PgEvidenceGapRepository implements P.EvidenceGapRepository {
  constructor(private readonly pool: pg.Pool) {}

  async openForObjective(
    interviewId: string, objectiveId: ObjectiveId, tx?: P.TxScope,
  ): Promise<EvidenceGap[]> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT * FROM evidence_gaps
        WHERE interview_id = $1 AND objective_id = $2 AND status = 'OPEN' ORDER BY created_at`,
      [interviewId, objectiveId],
    );
    return rows.map((r) => ({
      id: r.id, interviewId: r.interview_id, objectiveId: asObjectiveId(r.objective_id),
      gapType: r.gap_type, description: r.description, status: r.status,
      createdAt: iso(r.created_at), resolvedAt: r.resolved_at ? iso(r.resolved_at) : null,
    }));
  }

  async apply(intents: readonly GapIntent[], interviewId: string, tx: P.TxScope): Promise<void> {
    for (const i of intents) {
      if (i.kind === 'INSERT') {
        await exec(this.pool, tx).query(
          `INSERT INTO evidence_gaps (id, interview_id, objective_id, gap_type, gap_class,
             description, status)
           VALUES ($1,$2,$3,$4,$5,$6,'OPEN')
           ON CONFLICT (objective_id, gap_type) WHERE status = 'OPEN' DO NOTHING`,
          [`gap_${i.objectiveId}_${i.gapType}`, interviewId, i.objectiveId, i.gapType,
           classifyGap(i.gapType), i.description],
        );
      } else if (i.kind === 'REFRESH_DESCRIPTION') {
        await exec(this.pool, tx).query(
          `UPDATE evidence_gaps SET description = $2 WHERE id = $1`, [i.gapId, i.description],
        );
      } else if (i.kind === 'RESOLVE') {
        await exec(this.pool, tx).query(
          `UPDATE evidence_gaps SET status = 'RESOLVED', resolved_at = now() WHERE id = $1`,
          [i.gapId],
        );
      }
      // NOOP is logged by the caller, not persisted.
    }
  }

  async autoResolve(gapIds: readonly string[], tx: P.TxScope): Promise<void> {
    if (gapIds.length === 0) return;
    await exec(this.pool, tx).query(
      `UPDATE evidence_gaps SET status = 'RESOLVED', resolved_at = now() WHERE id = ANY($1::text[])`,
      [gapIds],
    );
  }

  async allForInterview(interviewId: string) {
    const { rows } = await exec(this.pool).query(
      `SELECT * FROM evidence_gaps WHERE interview_id = $1`, [interviewId],
    );
    return rows;
  }
}

// ---------------------------------------------------------------- assessments

export class PgAssessmentRepository implements P.AssessmentRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * C16 routing, implemented once here rather than repeated per call site:
   * a non-null requirementId updates BOTH the requirement rollup and the linked
   * competency rollup; null updates the competency rollup only.
   */
  async applyUpdates(
    interviewId: string, updates: readonly P.AssessmentUpdate[], tx: P.TxScope,
  ): Promise<void> {
    const q = exec(this.pool, tx);
    for (const u of updates) {
      if (u.requirementId !== null) {
        await q.query(
          `INSERT INTO requirement_assessments (interview_id, requirement_id, coverage_level,
             confidence_band, updated_at)
           VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (interview_id, requirement_id)
           DO UPDATE SET coverage_level = EXCLUDED.coverage_level,
                         confidence_band = EXCLUDED.confidence_band, updated_at = now()`,
          [interviewId, u.requirementId, u.coverageLevel, u.confidenceBand],
        );
      }
      const { rows } = await q.query(
        `SELECT competency_layer FROM interview_objectives
          WHERE interview_id = $1 AND competency_tag = $2 LIMIT 1`,
        [interviewId, u.competencyTag],
      );
      await q.query(
        `INSERT INTO competency_assessments (interview_id, competency_tag, competency_layer,
           coverage_level, confidence_band, updated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (interview_id, competency_tag)
         DO UPDATE SET coverage_level = EXCLUDED.coverage_level,
                       confidence_band = EXCLUDED.confidence_band, updated_at = now()`,
        [interviewId, u.competencyTag, rows[0]?.competency_layer ?? 'POSITION_SPECIFIC',
         u.coverageLevel, u.confidenceBand],
      );
    }
  }

  /** The rolled-up coverage the objective-status rule reads. */
  async coverageForObjective(
    interviewId: string, objective: InterviewObjective, tx?: P.TxScope,
  ): Promise<CoverageLevel> {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT coverage_level FROM competency_assessments
        WHERE interview_id = $1 AND competency_tag = $2`,
      [interviewId, objective.competencyTag],
    );
    return (rows[0]?.coverage_level as CoverageLevel) ?? 'NOT_COVERED';
  }

  async requirementRows(interviewId: string, tx?: P.TxScope) {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT * FROM requirement_assessments WHERE interview_id = $1 ORDER BY requirement_id`,
      [interviewId],
    );
    return rows;
  }

  async competencyRows(interviewId: string, tx?: P.TxScope) {
    const { rows } = await exec(this.pool, tx).query(
      `SELECT * FROM competency_assessments WHERE interview_id = $1 ORDER BY competency_tag`,
      [interviewId],
    );
    return rows;
  }

  async finalizeRequirement(
    interviewId: string, requirementId: string,
    v: { score: number | null; insufficientEvidenceFlag: boolean; gateStatus: string; notes: string; confidenceScore: number },
    tx: P.TxScope,
  ): Promise<void> {
    await exec(this.pool, tx).query(
      `UPDATE requirement_assessments SET score = $3, insufficient_evidence_flag = $4,
         gate_status = $5, notes = $6, confidence_score = $7, updated_at = now()
       WHERE interview_id = $1 AND requirement_id = $2`,
      [interviewId, requirementId, v.score, v.insufficientEvidenceFlag, v.gateStatus, v.notes, v.confidenceScore],
    );
  }

  async finalizeCompetency(
    interviewId: string, competencyTag: string,
    v: { score: number | null; rating: string; weight: number; rationale: string; confidenceScore: number },
    tx: P.TxScope,
  ): Promise<void> {
    await exec(this.pool, tx).query(
      `UPDATE competency_assessments SET score = $3, rating = $4, weight = $5,
         rationale = $6, confidence_score = $7, updated_at = now()
       WHERE interview_id = $1 AND competency_tag = $2`,
      [interviewId, competencyTag, v.score, v.rating, v.weight, v.rationale, v.confidenceScore],
    );
  }

  /** Seeds a NOT_COVERED row per requirement so every one is accounted for. */
  async seedRequirementRows(interviewId: string, requirementIds: readonly string[], tx: P.TxScope): Promise<void> {
    for (const id of requirementIds) {
      await exec(this.pool, tx).query(
        `INSERT INTO requirement_assessments (interview_id, requirement_id, coverage_level,
           confidence_band, insufficient_evidence_flag)
         VALUES ($1,$2,'NOT_COVERED','VERY_LOW',TRUE) ON CONFLICT DO NOTHING`,
        [interviewId, id],
      );
    }
  }
}

// -------------------------------------------------------------- final assessment

export class PgFinalAssessmentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(interviewId: string, fa: Record<string, unknown>, tx: P.TxScope): Promise<void> {
    await exec(this.pool, tx).query(
      `INSERT INTO final_assessments (interview_id, scoring_config_version, competency_score,
         competency_confidence_band, critical_gate_status, overall_recommendation,
         overall_confidence_band, key_strengths, concerns, unverified_areas, contradictions,
         risk_flags, nice_to_have_highlights, recommendation_rationale)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (interview_id) DO NOTHING`,
      [
        interviewId, fa.scoringConfigVersion, fa.competencyScore, fa.competencyConfidenceBand,
        fa.criticalGateStatus, fa.overallRecommendation, fa.overallConfidenceBand,
        JSON.stringify(fa.keyStrengths), JSON.stringify(fa.concerns),
        JSON.stringify(fa.unverifiedAreas), JSON.stringify(fa.contradictions),
        JSON.stringify(fa.riskFlags), JSON.stringify(fa.niceToHaveHighlights),
        fa.recommendationRationale,
      ],
    );
  }

  async load(interviewId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await exec(this.pool).query(
      `SELECT * FROM final_assessments WHERE interview_id = $1`, [interviewId],
    );
    return rows[0] ?? null;
  }
}

// -------------------------------------------------------------------- audit

export class PgAuditWriter implements P.AuditWriter {
  constructor(private readonly pool: pg.Pool) {}

  async write(interviewId: string, intents: readonly AuditIntent[], tx: P.TxScope): Promise<void> {
    await this.insert(interviewId, intents, exec(this.pool, tx));
  }

  /** For failures that must be recorded outside the main transaction. */
  async writeDetached(interviewId: string, intents: readonly AuditIntent[]): Promise<void> {
    await this.insert(interviewId, intents, this.pool);
  }

  private async insert(interviewId: string, intents: readonly AuditIntent[], q: ReturnType<typeof exec>) {
    for (const a of intents) {
      await q.query(
        `INSERT INTO audit_events (interview_id, type, rule, payload) VALUES ($1,$2,$3,$4)`,
        [interviewId, a.type, a.rule ?? null, JSON.stringify(a.payload)],
      );
    }
  }

  async forInterview(interviewId: string) {
    const { rows } = await this.pool.query(
      `SELECT type, rule, payload FROM audit_events WHERE interview_id = $1 ORDER BY id`,
      [interviewId],
    );
    return rows;
  }
}
