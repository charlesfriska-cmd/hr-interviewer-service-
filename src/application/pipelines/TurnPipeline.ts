/**
 * Submit-response turn pipeline — ARCHITECTURE.md §13, INTERVIEW_STATE.md v3 §3/§6.
 *
 * Transaction shape (ARCHITECTURE.md §19): any transaction that would hold open
 * across the LLM network call is split in two.
 *   TX-A  candidate answer, committed BEFORE the provider is called
 *   (no tx) context build, provider call, validation, rules, gap reconciliation
 *   TX-B  evidence, assessments, gaps, state CAS, next question, audit, operation
 *
 * Every failure path therefore leaves the candidate's answer durable and
 * InterviewState unadvanced, which is what makes a retry a resume rather than a
 * replay of a cached failure.
 */
import { autoResolveGaps } from '../../domain/gaps/autoResolve.ts';
import { reconcileGapUpdates, type GapUpdate } from '../../domain/gaps/reconcile.ts';
import { evaluateGuardrails, type RuleContext } from '../../domain/rules/guardrails.ts';
import {
  genuineAttempt,
  meetsSubstantiveCriteria,
  onQuestionPresented,
  afterAppliedTurn,
} from '../../domain/state/objectiveStatus.ts';
import { computeTurnActiveSeconds, remainingTimeMinutes } from '../../domain/time/activeTime.ts';
import { auditIntent, type AuditIntent } from '../../domain/audit/auditIntent.ts';
import { asObjectiveId, type Evidence, type InterviewObjective } from '../../domain/types/entities.ts';
import type { EvidenceGapType, InterviewPhase, RecommendedAction } from '../../domain/types/enums.ts';
import type {
  TxScope,
  AssessmentRepository,
  AssessmentUpdate,
  AuditWriter,
  CandidateResponseRepository,
  Clock,
  EvidenceGapRepository,
  EvidenceRepository,
  IdGenerator,
  InterviewRepository,
  InterviewStateRepository,
  LLMGateway,
  OperationStore,
  PlanRepository,
  QuestionRepository,
  SafetyScanner,
  UnitOfWork,
} from '../ports/ports.ts';

export interface SubmitResponseCommand {
  readonly interviewId: string;
  readonly questionId: string;
  readonly answer: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

/** The candidate-facing surface: message and question text only. Nothing else
 * from TurnDecision crosses this boundary (API_CONTRACT.md v3 §6). */
export interface TurnResponseBody {
  readonly status: 'in_progress' | 'complete';
  readonly message: string;
  readonly question?: { readonly id: string; readonly text: string };
}

export type TurnResult =
  | { readonly kind: 'ok'; readonly status: number; readonly body: TurnResponseBody }
  | { readonly kind: 'error'; readonly status: number; readonly code: string };

export interface TurnPipelineDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly uow: UnitOfWork;
  readonly operations: OperationStore;
  readonly interviews: InterviewRepository;
  readonly state: InterviewStateRepository;
  readonly plan: PlanRepository;
  readonly questions: QuestionRepository;
  readonly responses: CandidateResponseRepository;
  readonly evidence: EvidenceRepository;
  readonly gaps: EvidenceGapRepository;
  readonly assessments: AssessmentRepository;
  readonly audit: AuditWriter;
  readonly llm: LLMGateway;
  readonly safety: SafetyScanner;
  /**
   * Runs inside TX-B when the final action is COMPLETE_INTERVIEW, so the
   * CLOSING -> COMPLETED transition and the FinalAssessment commit atomically
   * with the turn that triggered them.
   */
  readonly finalize?: ((interviewId: string, tx: TxScope) => Promise<void>) | undefined;
}

/** The deterministic message shown when the provider path fails (§22 fail-soft). */
export const FALLBACK_MESSAGE =
  "Thanks — we're having a brief technical difficulty. Please hold for a moment and resend your answer.";

const TERMINAL_STATUSES = new Set(['COMPLETED', 'TERMINATED', 'ERROR']);

interface TurnDecisionShape {
  status: 'in_progress' | 'complete';
  recommended_action: RecommendedAction;
  candidate_message: string;
  question: {
    phase: InterviewPhase;
    objective: string;
    competency: string;
    question_type: string;
    text: string;
  } | null;
  evidence_updates: Array<{
    requirement_id: string | null;
    competency: string;
    summary: string;
    strength: Evidence['strength'];
  }>;
  assessment_updates: Array<{
    requirement_id: string | null;
    competency: string;
    coverage_level: AssessmentUpdate['coverageLevel'];
    confidence_band: AssessmentUpdate['confidenceBand'];
  }>;
  evidence_gap_updates: Array<{
    objective_ref: string;
    gap_type: EvidenceGapType;
    description: string;
    status: 'OPEN' | 'RESOLVED';
  }>;
  operational_reasoning: { objective: string; evidence_gap: string };
  contradiction_status: 'NONE' | 'RESOLVED' | 'UNRESOLVED';
  progress: { objectives_completed: number; objectives_total: number };
}

export class TurnPipeline {
  constructor(private readonly d: TurnPipelineDeps) {}

  async submit(cmd: SubmitResponseCommand): Promise<TurnResult> {
    const d = this.d;

    // ---- Steps 1-2: cheap deterministic rejections, before any provider spend.
    const interview = await d.interviews.load(cmd.interviewId);
    if (!interview) return { kind: 'error', status: 404, code: 'INTERVIEW_NOT_FOUND' };
    if (TERMINAL_STATUSES.has(interview.status)) {
      return { kind: 'error', status: 409, code: 'INTERVIEW_TERMINAL' };
    }

    const state = await d.state.load(cmd.interviewId);
    if (!state) return { kind: 'error', status: 404, code: 'STATE_NOT_FOUND' };

    // ---- Step 3: idempotency, consulted BEFORE the stale-question check.
    //
    // §6 distinguishes the two cases by key: the same key on an already-succeeded
    // turn is a replay and must return the cached body, while a different or
    // absent key on a question that has moved on is a stale resubmit. Checking
    // staleness first would make a legitimate network retry — the case idempotency
    // exists for — impossible, since lastQuestionId has advanced by then.
    //
    // The store resolves all six outcomes here, the B3 lease reclaim included, so
    // a crashed attempt resumes instead of wedging at 409.
    const claim = await d.operations.claim({
      scope: 'interview_response',
      idempotencyKey: cmd.idempotencyKey,
      requestHash: cmd.requestHash,
      interviewId: cmd.interviewId,
      questionId: cmd.questionId,
    });
    if (claim.kind === 'replay') {
      return { kind: 'ok', status: claim.status, body: claim.body as unknown as TurnResponseBody };
    }
    if (claim.kind === 'conflict') return { kind: 'error', status: 409, code: 'OPERATION_IN_FLIGHT' };
    if (claim.kind === 'terminal') return { kind: 'error', status: claim.status, code: 'OPERATION_TERMINAL' };

    // Not a replay: this must be an answer to the outstanding question.
    if (state.lastQuestionId !== cmd.questionId) {
      // Release the claim so a stale attempt cannot hold the key's lease.
      await d.operations.fail(claim.operationId, true);
      return { kind: 'error', status: 409, code: 'STALE_QUESTION' };
    }

    const question = await d.questions.load(cmd.questionId);
    if (!question) {
      await d.operations.fail(claim.operationId, true);
      return { kind: 'error', status: 404, code: 'QUESTION_NOT_FOUND' };
    }

    const now = d.clock.now();

    // ---- Step 4 (TX-A): the answer is durable before the provider is called.
    // On a resume the row already exists and must not be inserted twice.
    let response = await d.responses.findByQuestion(cmd.questionId);
    if (!response) {
      response = {
        id: d.ids.next('resp'),
        questionId: cmd.questionId,
        interviewId: cmd.interviewId,
        answerText: cmd.answer,
        receivedAt: now.toISOString(),
      };
      await d.responses.insertDurable(response);
    }

    // ---- B4: active time accrues from this turn only, clamped so an idle tab
    // cannot consume budget. Idle time is handled by a separate guardrail.
    const turnActiveSeconds = computeTurnActiveSeconds({
      presentedAt: new Date(question.presentedAt),
      receivedAt: new Date(response.receivedAt),
      maxCandidateResponseWindowSeconds: interview.maxCandidateResponseWindowSeconds,
    });
    const elapsedActive = state.elapsedActiveInterviewSeconds + turnActiveSeconds;

    const objectives = await d.plan.objectives(cmd.interviewId);
    const currentObjective = objectives.find((o) => o.id === question.objectiveId) ?? null;
    const mustHaveObjectiveIds = new Set(await d.plan.mustHaveObjectiveIds(cmd.interviewId));

    // ---- Steps 5-7: build context and call the agent. No transaction is open.
    const llmResult = await d.llm.runTurn({
      interviewId: cmd.interviewId,
      currentPhase: state.currentPhase,
      currentObjective,
      currentQuestion: { id: question.id, text: question.text },
      latestAnswer: response.answerText,
      constraints: {
        questionsAskedCount: state.questionsAskedCount,
        maxQuestions: interview.maxQuestions,
        followUpsUsedForObjective: state.followUpsByObjective[question.objectiveId] ?? 0,
        maxFollowUpsPerObjective: interview.maxFollowUpsPerObjective,
        remainingTimeMinutes: remainingTimeMinutes(elapsedActive, interview.maxDurationMinutes),
      },
    });

    // ---- Step 8: fail-soft. State is untouched and nothing is cached as a
    // success, so the next attempt resumes from an unadvanced state (C10).
    if (llmResult.kind === 'failed' || !llmResult.decision) {
      await d.audit.writeDetached(cmd.interviewId, [
        auditIntent('VALIDATION_FAILURE', 'AI_RESPONSE_UNUSABLE', {
          errors: llmResult.errors ?? [],
        }),
      ]);
      await d.operations.fail(claim.operationId, true);
      return {
        kind: 'ok',
        status: 200,
        body: { status: 'in_progress', message: FALLBACK_MESSAGE },
      };
    }

    const decision = llmResult.decision as TurnDecisionShape;
    const audit: AuditIntent[] = [];

    // ---- Step 9: guardrails. Reference validity is checked first: an unknown
    // objective or competency routes to retry rather than being corrected.
    const knownObjectiveIds = new Set(objectives.map((o) => String(o.id)));
    const knownCompetencies = new Set(objectives.map((o) => o.competencyTag));
    const referencesValid =
      decision.question === null ||
      (knownObjectiveIds.has(decision.question.objective) &&
        knownCompetencies.has(decision.question.competency));

    const ruleContext: RuleContext = {
      recommendedAction: decision.recommended_action,
      questionsAskedCount: state.questionsAskedCount,
      maxQuestions: interview.maxQuestions,
      elapsedActiveInterviewSeconds: elapsedActive,
      maxDurationMinutes: interview.maxDurationMinutes,
      followUpsUsedForObjective: state.followUpsByObjective[question.objectiveId] ?? 0,
      maxFollowUpsPerObjective: interview.maxFollowUpsPerObjective,
      unresolvedMustHaveObjectiveIds: objectives
        .filter(
          (o) =>
            (o.status === 'PENDING' || o.status === 'IN_PROGRESS') &&
            mustHaveObjectiveIds.has(String(o.id)),
        )
        .map((o) => String(o.id)),
      referencesValid,
    };

    const outcome = evaluateGuardrails(ruleContext);
    if (outcome.kind === 'RETRY') {
      await d.audit.writeDetached(cmd.interviewId, outcome.audit);
      await d.operations.fail(claim.operationId, true);
      return {
        kind: 'ok',
        status: 200,
        body: { status: 'in_progress', message: FALLBACK_MESSAGE },
      };
    }
    audit.push(...outcome.audit);
    const finalAction = outcome.finalAction;

    // ---- Safety backstop. A denylist match in candidate_message substitutes the
    // whole message rather than redacting mid-sentence, so the candidate never
    // reads a mangled line (AMENDMENTS.md O1).
    const scanned = d.safety.scan(decision.candidate_message);
    let candidateMessage = decision.candidate_message;
    if (scanned.matched) {
      candidateMessage = FALLBACK_MESSAGE;
      audit.push(
        auditIntent('GUARDRAIL_OVERRIDE', 'PROTECTED_CHARACTERISTIC_FILTERED', {
          field: 'candidate_message',
        }),
      );
    }

    // ---- Gap reconciliation, then A5 auto-resolution.
    const gapUpdates: GapUpdate[] = [];
    for (const g of decision.evidence_gap_updates) {
      if (!knownObjectiveIds.has(g.objective_ref)) {
        audit.push(
          auditIntent('GUARDRAIL_OVERRIDE', 'INVALID_GAP_UPDATE_DROPPED', {
            objectiveRef: g.objective_ref,
            gapType: g.gap_type,
          }),
        );
        continue;
      }
      gapUpdates.push({
        objectiveId: asObjectiveId(g.objective_ref),
        gapType: g.gap_type,
        description: d.safety.scan(g.description).text,
        status: g.status,
      });
    }

    const objectiveForGaps = currentObjective;
    const gapIntents = gapUpdates.length > 0 && objectiveForGaps
      ? reconcileGapUpdates(
          await d.gaps.openForObjective(cmd.interviewId, objectiveForGaps.id),
          gapUpdates,
        )
      : [];

    // ---- Step 10-15 (TX-B): everything derived from this decision commits together.
    const committed = await d.uow.run(async (tx) => {
      if (gapIntents.length > 0) await d.gaps.apply(gapIntents, cmd.interviewId, tx);

      const evidenceRows: Evidence[] = decision.evidence_updates.map((e) => ({
        id: d.ids.next('ev'),
        interviewId: cmd.interviewId,
        requirementId: e.requirement_id,
        competencyTag: e.competency,
        // Never trusted from AI output — taken from this turn's own response.
        sourceResponseId: response.id,
        summary: d.safety.scan(e.summary).text,
        strength: e.strength,
        createdAt: now.toISOString(),
      }));
      if (evidenceRows.length > 0) await d.evidence.insertMany(evidenceRows, tx);

      if (decision.assessment_updates.length > 0) {
        await d.assessments.applyUpdates(
          cmd.interviewId,
          decision.assessment_updates.map((a) => ({
            requirementId: a.requirement_id,
            competencyTag: a.competency,
            coverageLevel: a.coverage_level,
            confidenceBand: a.confidence_band,
          })),
          tx,
        );
      }

      // ---- A5: Node owns objective completion. Once the substantive conditions
      // hold, advisory gaps the latest assessment no longer supports are cleared
      // deterministically — success never waits on the model closing its own note.
      if (objectiveForGaps) {
        const openAfter = await d.gaps.openForObjective(cmd.interviewId, objectiveForGaps.id);
        const strengths = await d.evidence.strengthsForObjective(cmd.interviewId, objectiveForGaps);
        const coverage = await d.assessments.coverageForObjective(cmd.interviewId, objectiveForGaps);
        const questionCount = await d.questions.countForObjective(
          cmd.interviewId,
          objectiveForGaps.id,
        );

        const evalInput = {
          objective: objectiveForGaps,
          coverageLevel: coverage,
          evidenceStrengths: strengths,
          openGaps: openAfter,
          questionCount,
        };

        const auto = autoResolveGaps({
          objectiveId: String(objectiveForGaps.id),
          openGaps: openAfter,
          substantiveConditionsMet: meetsSubstantiveCriteria(evalInput),
          reassertedGapTypes: new Set(
            gapUpdates.filter((g) => g.status === 'OPEN').map((g) => g.gapType),
          ),
          contradictionStatus: decision.contradiction_status,
        });
        if (auto.resolvedGapIds.length > 0) await d.gaps.autoResolve(auto.resolvedGapIds, tx);
        audit.push(...auto.audit);

        const remainingOpen = openAfter.filter((g) => !auto.resolvedGapIds.includes(g.id));
        const nextStatus = afterAppliedTurn({ ...evalInput, openGaps: remainingOpen });
        if (nextStatus !== objectiveForGaps.status) {
          await d.plan.setObjectiveStatus(cmd.interviewId, objectiveForGaps.id, nextStatus, tx);
          audit.push(
            auditIntent('STATE_TRANSITION', 'OBJECTIVE_STATUS', {
              objectiveId: String(objectiveForGaps.id),
              from: objectiveForGaps.status,
              to: nextStatus,
              genuineAttempt: genuineAttempt(objectiveForGaps, questionCount),
            }),
          );
        }
      }

      // ---- Next question, unless the interview is completing.
      let nextQuestion: { id: string; text: string } | undefined;
      const isComplete = finalAction === 'COMPLETE_INTERVIEW';
      if (!isComplete && decision.question) {
        const objectiveId = asObjectiveId(decision.question.objective);
        const q = {
          id: d.ids.next('q'),
          interviewId: cmd.interviewId,
          objectiveId,
          // Node sets the phase from state, never from the AI's proposal.
          phase: state.currentPhase as InterviewPhase,
          text: decision.question.text,
          presentedAt: now.toISOString(),
          sequenceNumber: state.questionsAskedCount + 1,
          competencyTag: decision.question.competency,
          questionType: decision.question.question_type,
        };
        await d.questions.insert(q, tx);
        nextQuestion = { id: q.id, text: q.text };

        const target = objectives.find((o) => o.id === objectiveId);
        if (target) {
          const advanced = onQuestionPresented(target.status);
          if (advanced !== target.status) {
            await d.plan.setObjectiveStatus(cmd.interviewId, objectiveId, advanced, tx);
          }
        }
      }

      // ---- State CAS. A mismatch aborts the turn rather than overwriting a
      // concurrent update; the client resubmits with the same key and resumes.
      const followUps = { ...state.followUpsByObjective };
      if (finalAction === 'FOLLOW_UP' || finalAction === 'DEEP_DIVE' || finalAction === 'CLARIFY') {
        followUps[question.objectiveId] = (followUps[question.objectiveId] ?? 0) + 1;
      }
      const phaseElapsed = { ...state.phaseElapsedSeconds };
      const phaseKey = state.currentPhase as InterviewPhase;
      phaseElapsed[phaseKey] = (phaseElapsed[phaseKey] ?? 0) + turnActiveSeconds;

      const nextState = {
        ...state,
        questionsAskedCount: state.questionsAskedCount + (nextQuestion ? 1 : 0),
        followUpsByObjective: followUps,
        elapsedActiveInterviewSeconds: elapsedActive,
        phaseElapsedSeconds: phaseElapsed,
        lastActivityAt: now.toISOString(),
        lastQuestionId: nextQuestion ? nextQuestion.id : state.lastQuestionId,
        version: state.version + 1,
        updatedAt: now.toISOString(),
      };

      const swapped = await d.state.compareAndSwap(nextState, state.version, tx);
      if (!swapped) return null;

      const body = {
        status: (isComplete ? 'complete' : 'in_progress') as 'in_progress' | 'complete',
        message: candidateMessage,
        ...(nextQuestion ? { question: nextQuestion } : {}),
      };

      audit.push(
        auditIntent('AI_CALL', undefined, {
          recommendedAction: decision.recommended_action,
          appliedAction: finalAction,
          operationalReasoning: decision.operational_reasoning,
          contradictionStatus: decision.contradiction_status,
        }),
      );
      await d.audit.write(cmd.interviewId, audit, tx);

      // Step 16: forced or recommended completion runs finalization in the same
      // transaction — CLOSING -> COMPLETED always fires and is never partial.
      if (isComplete && d.finalize) await d.finalize(cmd.interviewId, tx);

      await d.operations.succeed(claim.operationId, 200, body, tx);
      return body;
    });

    if (committed === null) {
      await d.operations.fail(claim.operationId, true);
      return { kind: 'error', status: 409, code: 'STATE_VERSION_CONFLICT' };
    }

    return { kind: 'ok', status: 200, body: committed };
  }
}
