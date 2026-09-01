/**
 * Deterministic finalization — INTERVIEW_STATE.md v3 §8, SCORING_FRAMEWORK.md v3.
 *
 * Runs at CLOSING -> COMPLETED. No LLM call exists anywhere in this path: scores,
 * ratings, gate statuses, the recommendation and every narrative field are
 * computed by Node.js from already-persisted evidence.
 */
import type pg from 'pg';
import { SCORING_CONFIG_VERSION } from '../../config/scoring.config.ts';
import { bandMidpoint } from '../../domain/scoring/confidence.ts';
import { computeScore } from '../../domain/scoring/scoreTable.ts';
import { deriveRating } from '../../domain/scoring/rating.ts';
import {
  computeCompetencyScore,
  resolveCompetencyWeight,
} from '../../domain/scoring/competencyTrack.ts';
import { aggregateCriticalGateStatus, evaluateGateStatus } from '../../domain/scoring/gates.ts';
import {
  computeOverallRecommendation,
  type RequirementOutcome,
} from '../../domain/scoring/recommendation.ts';
import * as tpl from '../../domain/narrative/templates.ts';
import { auditIntent, type AuditIntent } from '../../domain/audit/auditIntent.ts';
import { autoResolveGaps } from '../../domain/gaps/autoResolve.ts';
import { meetsSubstantiveCriteria, onObjectiveClosed } from '../../domain/state/objectiveStatus.ts';
import type { EvidenceGap, ObjectiveId } from '../../domain/types/entities.ts';
import type { EvidenceGapType } from '../../domain/types/enums.ts';
import type {
  CompetencyAssessment,
  JobRequirement,
  RequirementAssessment,
} from '../../domain/types/entities.ts';
import type {
  CompetencyLayer,
  ConfidenceBand,
  CoverageLevel,
  EvidenceStrength,
} from '../../domain/types/enums.ts';
import { exec } from '../../persistence/db/pool.ts';
import type { TxScope, UnitOfWork } from '../ports/ports.ts';
import type {
  PgAssessmentRepository,
  PgAuditWriter,
  PgEvidenceRepository,
  PgFinalAssessmentRepository,
  PgInterviewRepository,
  PgPlanRepository,
  PgReferenceRepository,
} from '../../persistence/repositories/repositories.ts';

export interface FinalizeDeps {
  readonly pool: pg.Pool;
  readonly uow: UnitOfWork;
  readonly interviews: PgInterviewRepository;
  readonly reference: PgReferenceRepository;
  readonly plan: PgPlanRepository;
  readonly evidence: PgEvidenceRepository;
  readonly assessments: PgAssessmentRepository;
  readonly finals: PgFinalAssessmentRepository;
  readonly audit: PgAuditWriter;
}

export class FinalizeInterviewService {
  constructor(private readonly d: FinalizeDeps) {}

  /** Idempotent: a second call is a no-op because the insert is ON CONFLICT DO NOTHING. */
  async finalize(interviewId: string, tx: TxScope): Promise<void> {
    const d = this.d;
    const now = new Date().toISOString();

    // Every read here must run inside the caller's transaction: finalization is
    // invoked from within TX-B, so a pool connection would not see the evidence,
    // assessments or gaps that same turn has just written but not yet committed.
    const q = exec(d.pool, tx);

    const requirements = await d.reference.requirementsForInterview(interviewId, tx);
    const objectives = await d.plan.objectives(interviewId, tx);
    const evidenceRows = await d.evidence.forInterview(interviewId, tx);
    const reqRows = await d.assessments.requirementRows(interviewId, tx);
    const compRows = await d.assessments.competencyRows(interviewId, tx);
    const gapRows = (
      await q.query(`SELECT * FROM evidence_gaps WHERE interview_id = $1`, [interviewId])
    ).rows;
    const questionCounts = (
      await q.query(
        `SELECT objective_id, count(*) AS n FROM questions WHERE interview_id = $1 GROUP BY objective_id`,
        [interviewId],
      )
    ).rows as Array<{ objective_id: string; n: string }>;
    const askedByObjective = new Map(questionCounts.map((r) => [r.objective_id, Number(r.n)]));

    // ---- A5 sweep, before any scoring reads objective status.
    //
    // Auto-resolution during a turn only reaches the objective being answered. An
    // objective the interview has already moved past can still carry an advisory
    // gap the agent opened and never closed; left alone it would settle as
    // INSUFFICIENT_EVIDENCE and drop a genuinely successful objective out of the
    // weighted average. Sweeping every objective here is what makes objective
    // success independent of the model emitting a gap-close action.
    //
    // Nothing is re-asserted at finalization (there is no new turn), and the
    // contradiction status is deliberately NONE, so a blocking gap is never
    // cleared by this sweep.
    const sweepAudit: AuditIntent[] = [];
    for (const o of objectives) {
      const openGaps: EvidenceGap[] = gapRows
        .filter((g) => g.objective_id === String(o.id) && g.status === 'OPEN')
        .map((g) => ({
          id: g.id as string,
          interviewId,
          objectiveId: o.id as ObjectiveId,
          gapType: g.gap_type as EvidenceGapType,
          description: g.description as string,
          status: 'OPEN' as const,
          createdAt: String(g.created_at),
          resolvedAt: null,
        }));

      const strengths = evidenceRows
        .filter((e) => e.competencyTag === o.competencyTag || (e.requirementId !== null && o.requirementIds.includes(e.requirementId)))
        .map((e) => e.strength as EvidenceStrength);
      const coverage =
        (compRows.find((c) => c.competency_tag === o.competencyTag)?.coverage_level as CoverageLevel) ?? 'NOT_COVERED';

      const evalInput = {
        objective: o,
        coverageLevel: coverage,
        evidenceStrengths: strengths,
        openGaps,
        questionCount: askedByObjective.get(String(o.id)) ?? 0,
      };

      const auto = autoResolveGaps({
        objectiveId: String(o.id),
        openGaps,
        substantiveConditionsMet: meetsSubstantiveCriteria(evalInput),
        reassertedGapTypes: new Set<EvidenceGapType>(),
        contradictionStatus: 'NONE',
      });
      if (auto.resolvedGapIds.length > 0) {
        await q.query(
          `UPDATE evidence_gaps SET status = 'RESOLVED', resolved_at = now() WHERE id = ANY($1::text[])`,
          [auto.resolvedGapIds],
        );
        for (const g of gapRows) {
          if (auto.resolvedGapIds.includes(g.id as string)) g.status = 'RESOLVED';
        }
      }
      sweepAudit.push(...auto.audit);

      // Settle the objective. PENDING stays PENDING — never reached is reported
      // distinctly from attempted-but-unresolved.
      const remaining = openGaps.filter((g) => !auto.resolvedGapIds.includes(g.id));
      const settled = onObjectiveClosed({ ...evalInput, openGaps: remaining });
      if (settled !== o.status) {
        await d.plan.setObjectiveStatus(interviewId, o.id, settled, tx);
        sweepAudit.push(
          auditIntent('STATE_TRANSITION', 'OBJECTIVE_SETTLED', {
            objectiveId: String(o.id), from: o.status, to: settled,
          }),
        );
        (o as { status: string }).status = settled;
      }
    }
    if (sweepAudit.length > 0) await d.audit.write(interviewId, sweepAudit, tx);

    // An objective had a genuine attempt when it left PENDING and at least one
    // question was actually asked against it (INTERVIEW_STATE v3 §5a).
    const attemptedCompetencies = new Set<string>();
    const attemptedRequirements = new Set<string>();
    for (const o of objectives) {
      const asked = askedByObjective.get(String(o.id)) ?? 0;
      if (o.status !== 'PENDING' && asked >= 1) {
        attemptedCompetencies.add(o.competencyTag);
        for (const rid of o.requirementIds) attemptedRequirements.add(rid);
      }
    }

    // ---- Step 1: RequirementAssessment.score — Requirement Fit track only.
    const requirementAssessments: RequirementAssessment[] = [];
    const requirementOutcomes: RequirementOutcome[] = [];
    for (const req of requirements) {
      const row = reqRows.find((r) => r.requirement_id === req.id);
      const coverage = (row?.coverage_level as CoverageLevel) ?? 'NOT_COVERED';
      const band = (row?.confidence_band as ConfidenceBand) ?? 'VERY_LOW';
      const strengths = evidenceRows
        .filter((e) => e.requirementId === req.id)
        .map((e) => e.strength as EvidenceStrength);
      const genuine = attemptedRequirements.has(req.id);

      const scored = genuine
        ? computeScore(strengths, coverage)
        : { score: null, insufficientEvidenceFlag: true };

      const openGaps = gapRows
        .filter(
          (g) =>
            g.status === 'OPEN' &&
            objectives.some((o) => String(o.id) === g.objective_id && o.requirementIds.includes(req.id)),
        )
        .map((g) => g.description as string);

      const notes = tpl.requirementNotes({
        coverageLevel: coverage,
        topEvidenceSummaries: evidenceRows.filter((e) => e.requirementId === req.id).map((e) => e.summary),
        openGapDescriptions: openGaps,
        genuineAttempt: genuine,
      });

      const assessment: RequirementAssessment = {
        requirementId: req.id,
        interviewId,
        coverageLevel: coverage,
        score: scored.score,
        confidenceBand: band,
        confidenceScore: bandMidpoint(band),
        evidenceIds: evidenceRows.filter((e) => e.requirementId === req.id).map((e) => e.id),
        gapIds: [],
        insufficientEvidenceFlag: scored.insufficientEvidenceFlag,
        gateStatus: 'NOT_A_GATE',
        notes,
      };

      const jobReq: JobRequirement = {
        id: req.id, positionId: req.positionId, label: req.label, description: req.description,
        priority: req.priority, competencyTag: req.competencyTag, criticalGate: req.criticalGate,
      };

      // ---- Step 4: gate evaluation. B1 — requirements are the only gates.
      const gateStatus = evaluateGateStatus({ requirement: jobReq, assessment, genuineAttempt: genuine });
      const finalised = { ...assessment, gateStatus };
      requirementAssessments.push(finalised);
      requirementOutcomes.push({ requirement: jobReq, assessment: finalised, gateStatus, genuineAttempt: genuine });

      await d.assessments.finalizeRequirement(
        interviewId, req.id,
        {
          score: scored.score,
          insufficientEvidenceFlag: scored.insufficientEvidenceFlag,
          gateStatus,
          notes,
          confidenceScore: bandMidpoint(band),
        },
        tx,
      );
    }

    // ---- Steps 2-3: CompetencyAssessment score and threshold-derived rating.
    const competencyAssessments: CompetencyAssessment[] = [];
    for (const row of compRows) {
      const tag = row.competency_tag as string;
      const layer = (row.competency_layer as CompetencyLayer) ?? 'POSITION_SPECIFIC';
      const coverage = row.coverage_level as CoverageLevel;
      const band = row.confidence_band as ConfidenceBand;
      const strengths = evidenceRows
        .filter((e) => e.competencyTag === tag)
        .map((e) => e.strength as EvidenceStrength);
      const genuine = attemptedCompetencies.has(tag);

      const scored = genuine
        ? computeScore(strengths, coverage)
        : { score: null, insufficientEvidenceFlag: true };
      const rating = deriveRating(scored.score);
      const weight = resolveCompetencyWeight(tag, layer);
      const rationale = tpl.competencyRationale({
        competencyTag: tag,
        coverageLevel: coverage,
        topEvidenceSummaries: evidenceRows.filter((e) => e.competencyTag === tag).map((e) => e.summary),
      });

      competencyAssessments.push({
        competencyTag: tag, interviewId, coverageLevel: coverage, rating,
        score: scored.score, confidenceBand: band, confidenceScore: bandMidpoint(band),
        evidenceIds: evidenceRows.filter((e) => e.competencyTag === tag).map((e) => e.id),
        gapIds: [], weight, rationale,
      });

      await d.assessments.finalizeCompetency(
        interviewId, tag,
        { score: scored.score, rating, weight, rationale, confidenceScore: bandMidpoint(band) },
        tx,
      );
    }

    // ---- Step 5: competencyScore, from competency rows only. Never blended with
    // requirement scores (C5).
    const { competencyScore, competencyConfidenceBand } = computeCompetencyScore(competencyAssessments);

    // ---- Step 6: criticalGateStatus across gated requirements only (B2).
    const criticalGateStatus = aggregateCriticalGateStatus(
      requirementOutcomes.filter((o) => o.requirement.criticalGate).map((o) => o.gateStatus),
    );

    // ---- Step 7: the deterministic recommendation algorithm (B6).
    const rec = computeOverallRecommendation({
      competencyScore, competencyConfidenceBand, requirementOutcomes,
    });

    // ---- Step 8: narrative fields, all templated.
    const keyStrengths = competencyAssessments
      .filter((c) => (c.score ?? 0) >= 4)
      .flatMap((c) => {
        const top = evidenceRows.filter((e) => e.competencyTag === c.competencyTag)[0];
        return top ? [tpl.keyStrength(c.competencyTag, top.summary)] : [];
      })
      .slice(0, 3);

    const unverifiedAreas = objectives.flatMap((o) => {
      const asked = askedByObjective.get(String(o.id)) ?? 0;
      const genuine = o.status !== 'PENDING' && asked >= 1;
      if (o.status === 'SATISFIED') return [];
      return [genuine ? tpl.unverifiedInsufficient(o.competencyTag) : tpl.unverifiedNotReached(o.competencyTag)];
    });

    // C6: nice-to-have is reported here and enters no computation above.
    const niceToHaveHighlights = requirements
      .filter((r) => r.priority === 'NICE_TO_HAVE')
      .flatMap((r) => {
        const ev = evidenceRows.find((e) => e.requirementId === r.id);
        return ev ? [tpl.niceToHaveHighlight(r.label, ev.summary)] : [];
      });

    // One entry per turn whose contradiction_status was not NONE (§8.2).
    const aiCallRows = (
      await q.query(
        `SELECT payload FROM audit_events WHERE interview_id = $1 AND type = 'AI_CALL' ORDER BY id`,
        [interviewId],
      )
    ).rows as Array<{
      payload: { contradictionStatus?: string; operationalReasoning?: { evidence_gap?: string } };
    }>;
    const contradictions = aiCallRows
      .filter((r) => r.payload?.contradictionStatus && r.payload.contradictionStatus !== 'NONE')
      .map((r) => ({
        description: r.payload.operationalReasoning?.evidence_gap ?? 'contradiction recorded',
        resolved: r.payload.contradictionStatus === 'RESOLVED',
      }));

    const concerns = [
      ...rec.concerns,
      ...requirementAssessments
        .filter((r) => r.gateStatus === 'FAILED')
        .map((r) => `Critical gate not met for requirement ${r.requirementId}`),
    ];

    const finalAssessment = {
      scoringConfigVersion: SCORING_CONFIG_VERSION,
      competencyScore,
      competencyConfidenceBand,
      criticalGateStatus,
      overallRecommendation: rec.overallRecommendation,
      overallConfidenceBand: competencyConfidenceBand,
      keyStrengths,
      concerns,
      unverifiedAreas,
      contradictions,
      riskFlags: rec.riskFlags,
      niceToHaveHighlights,
      recommendationRationale: tpl.recommendationRationale({
        recommendation: rec.overallRecommendation,
        competencyScore,
        confidenceBand: competencyConfidenceBand,
        gateStatus: criticalGateStatus,
        riskFlags: rec.riskFlags,
      }),
    };

    await d.finals.insert(interviewId, finalAssessment, tx);
    await d.interviews.setStatus(interviewId, 'COMPLETED' as never, now, tx);
    await d.audit.write(interviewId, [
      auditIntent('STATE_TRANSITION', 'FINALIZED', {
        from: 'CLOSING', to: 'COMPLETED',
        overallRecommendation: rec.overallRecommendation,
        scoringConfigVersion: SCORING_CONFIG_VERSION,
      }),
    ], tx);
  }
}
