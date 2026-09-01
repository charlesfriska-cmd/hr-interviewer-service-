/**
 * Create-interview pipeline — ARCHITECTURE.md §12, API_CONTRACT.md v3 §2.3/§5/§6.
 *
 * Transaction shape: TX1 persists the interview and its inputs, the provider is
 * called with NO transaction open, then TX2 persists the plan, first question and
 * state. That split is what lets a failed attempt resume without re-entering data
 * (API_CONTRACT.md v3 §5 step 5) and never holds a lock across network I/O.
 *
 * Node.js is authoritative for every identifier, timestamp, sequence number and
 * lifecycle status. The AI proposes objectives; it never mints canonical ids.
 */
import { auditIntent, type AuditIntent } from '../../domain/audit/auditIntent.ts';
import { buildInitializationPayload } from '../../llm/prompt/buildUserPayload.ts';
import { validatePlan, type PlanRejectionReason } from '../../domain/rules/planRules.ts';
import { asObjectiveId, type Interview, type InterviewObjective } from '../../domain/types/entities.ts';
import type { InterviewPhase } from '../../domain/types/enums.ts';
import type { Clock, IdGenerator, OperationClaim, TxScope, UnitOfWork } from '../ports/ports.ts';

export interface CreateInterviewCommand {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly candidate: { readonly fullName: string; readonly cvRawText: string };
  readonly position: {
    readonly title: string;
    readonly jobDescription: string;
    readonly companyContext?: string | undefined;
    readonly organizationalValues?: string | undefined;
  };
  readonly requirements: ReadonlyArray<{
    readonly label: string;
    readonly description?: string | undefined;
    readonly priority: 'MUST_HAVE' | 'NICE_TO_HAVE';
    readonly competencyTag: string;
    readonly criticalGate?: boolean | undefined;
  }>;
  readonly maxDurationMinutes?: number | undefined;
  readonly maxQuestions?: number | undefined;
  readonly maxFollowUpsPerObjective?: number | undefined;
}

export interface CreateInterviewBody {
  readonly interviewId: string;
  readonly status: 'OPENING';
  readonly question: { readonly id: string; readonly text: string };
  readonly message: string;
}

export type CreateInterviewResult =
  | { readonly kind: 'ok'; readonly status: number; readonly body: CreateInterviewBody }
  | { readonly kind: 'error'; readonly status: number; readonly code: string; readonly detail?: string };

export interface InitializationDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly uow: UnitOfWork;
  readonly operations: {
    claim(input: {
      scope: 'interview_create';
      idempotencyKey: string;
      requestHash: string;
    }): Promise<OperationClaim>;
    succeed(id: string, status: number, body: Record<string, unknown>, tx: TxScope): Promise<void>;
    fail(id: string, retryable: boolean): Promise<void>;
    attachInterview(id: string, interviewId: string): Promise<void>;
    interviewIdFor(id: string): Promise<string | null>;
  };
  readonly interviews: {
    insert(i: Interview, tx?: TxScope): Promise<void>;
    load(id: string): Promise<Interview | null>;
    markStarted(id: string, status: 'OPENING', startedAt: string, tx: TxScope): Promise<void>;
    setStatus(id: string, status: 'ERROR' | 'PRE_INTERVIEW_ANALYSIS', at: string, tx?: TxScope): Promise<void>;
  };
  readonly reference: {
    insertCandidate(c: { id: string; fullName: string; cvRawText: string; createdAt: string }, tx?: TxScope): Promise<void>;
    insertPosition(p: {
      id: string; title: string; jobDescription: string;
      companyContext?: string | undefined; organizationalValues?: string | undefined; createdAt: string;
    }, tx?: TxScope): Promise<void>;
    insertRequirements(positionId: string, reqs: ReadonlyArray<{
      id: string; label: string; description: string;
      priority: 'MUST_HAVE' | 'NICE_TO_HAVE'; competencyTag: string; criticalGate: boolean;
    }>, tx?: TxScope): Promise<void>;
    requirementsForInterview(id: string): Promise<Array<{ id: string; label: string; priority: string; competencyTag: string; criticalGate: boolean }>>;
  };
  readonly plan: {
    insertPlan(interviewId: string, version: number, createdAt: string, tx: TxScope): Promise<void>;
    insertObjective(interviewId: string, o: InterviewObjective & { aiRef: string; ordinal: number }, tx: TxScope): Promise<void>;
  };
  readonly questions: { insert(q: {
    id: string; interviewId: string; objectiveId: ReturnType<typeof asObjectiveId>;
    phase: InterviewPhase; text: string; presentedAt: string; sequenceNumber: number;
    competencyTag: string | null; questionType: string;
  }, tx: TxScope): Promise<void> };
  readonly state: { insert(s: Parameters<import('../ports/ports.ts').InterviewStateRepository['compareAndSwap']>[0], tx: TxScope): Promise<void> };
  readonly assessments: { seedRequirementRows(interviewId: string, requirementIds: readonly string[], tx: TxScope): Promise<void> };
  readonly audit: {
    write(interviewId: string, intents: readonly AuditIntent[], tx: TxScope): Promise<void>;
    writeDetached(interviewId: string, intents: readonly AuditIntent[]): Promise<void>;
  };
  readonly llm: { generate(mode: 'initialization', payload: unknown): Promise<{ kind: 'ok' | 'failed'; decision?: unknown; errors?: string[] }> };
  readonly limits: {
    maxDurationMinutes: number; maxQuestions: number; maxFollowUpsPerObjective: number;
    maxCandidateResponseWindowSeconds: number; sessionIdleTimeoutMinutes: number;
  };
  /** Truncation caps applied before any text reaches the provider. */
  readonly contextLimits: { maxCvChars: number; maxJdChars: number };
}

interface InitializationDecisionShape {
  candidate_message: string;
  objectives: Array<{
    ref: string; phase: InterviewPhase; requirement_ids: string[];
    competency_tag: string; target_evidence_count: number;
  }>;
  first_question: { objective_ref: string; competency: string; question_type: string; text: string };
  operational_reasoning: { objective: string; evidence_gap: string };
}

export class InitializationPipeline {
  constructor(private readonly d: InitializationDeps) {}

  async create(cmd: CreateInterviewCommand): Promise<CreateInterviewResult> {
    const d = this.d;

    // ---- Step 1-2: idempotency. Resolves replay / conflict / terminal, and the
    // B3 lease reclaim, before any work is done.
    const claim = await d.operations.claim({
      scope: 'interview_create',
      idempotencyKey: cmd.idempotencyKey,
      requestHash: cmd.requestHash,
    });
    if (claim.kind === 'replay') {
      return { kind: 'ok', status: claim.status, body: claim.body as unknown as CreateInterviewBody };
    }
    if (claim.kind === 'conflict') return { kind: 'error', status: 409, code: 'OPERATION_IN_FLIGHT' };
    if (claim.kind === 'terminal') {
      return { kind: 'error', status: claim.status, code: 'INITIALIZATION_FAILED' };
    }

    const now = d.clock.now();
    const nowIso = now.toISOString();

    // ---- Step 3 (TX1): interview and inputs. On a resume these rows already
    // exist and are reused rather than re-inserted — no data is re-entered.
    let interviewId = await d.operations.interviewIdFor(claim.operationId);
    if (!interviewId) {
      interviewId = d.ids.next('int');
      const candidateId = d.ids.next('cand');
      const positionId = d.ids.next('pos');
      const requirements = cmd.requirements.map((r, i) => ({
        id: `${positionId}_req_${i + 1}`,
        label: r.label,
        description: r.description ?? '',
        priority: r.priority,
        competencyTag: r.competencyTag,
        criticalGate: r.criticalGate ?? false,
      }));

      const interview: Interview = {
        id: interviewId,
        candidateId,
        positionId,
        status: 'INITIALIZING',
        createdAt: nowIso,
        updatedAt: nowIso,
        maxDurationMinutes: cmd.maxDurationMinutes ?? d.limits.maxDurationMinutes,
        maxQuestions: cmd.maxQuestions ?? d.limits.maxQuestions,
        maxFollowUpsPerObjective: cmd.maxFollowUpsPerObjective ?? d.limits.maxFollowUpsPerObjective,
        maxCandidateResponseWindowSeconds: d.limits.maxCandidateResponseWindowSeconds,
        sessionIdleTimeoutMinutes: d.limits.sessionIdleTimeoutMinutes,
      };

      const createdId = interviewId;
      await d.uow.run(async (tx) => {
        await d.reference.insertCandidate(
          { id: candidateId, fullName: cmd.candidate.fullName, cvRawText: cmd.candidate.cvRawText, createdAt: nowIso },
          tx,
        );
        await d.reference.insertPosition(
          {
            id: positionId, title: cmd.position.title, jobDescription: cmd.position.jobDescription,
            companyContext: cmd.position.companyContext,
            organizationalValues: cmd.position.organizationalValues, createdAt: nowIso,
          },
          tx,
        );
        await d.interviews.insert(interview, tx);
        await d.reference.insertRequirements(positionId, requirements, tx);
        await d.interviews.setStatus(createdId, 'PRE_INTERVIEW_ANALYSIS', nowIso, tx);
        await d.audit.write(createdId, [
          auditIntent('STATE_TRANSITION', 'INTERVIEW_CREATED', {
            from: 'INITIALIZING', to: 'PRE_INTERVIEW_ANALYSIS',
          }),
        ], tx);
        return true;
      });
      await d.operations.attachInterview(claim.operationId, createdId);
    }

    const requirementRows = await d.reference.requirementsForInterview(interviewId);
    const knownRequirementIds = new Set(requirementRows.map((r) => r.id));

    // ---- Steps 4-5: build the compact context and call the agent. No transaction
    // is open. criticalGate is deliberately absent from what the AI receives (C4).
    const llm = await d.llm.generate(
      'initialization',
      buildInitializationPayload({
        interviewId,
        positionTitle: cmd.position.title,
        jobDescription: cmd.position.jobDescription,
        companyContext: cmd.position.companyContext,
        organizationalValues: cmd.position.organizationalValues,
        requirements: requirementRows.map((r) => ({
          id: r.id,
          label: r.label,
          priority: r.priority as 'MUST_HAVE' | 'NICE_TO_HAVE',
          competencyTag: r.competencyTag,
          // criticalGate is deliberately not mapped through (C4).
        })),
        candidateFullName: cmd.candidate.fullName,
        candidateCvText: cmd.candidate.cvRawText,
        constraints: {
          maxQuestions: cmd.maxQuestions ?? d.limits.maxQuestions,
          maxFollowUpsPerObjective: cmd.maxFollowUpsPerObjective ?? d.limits.maxFollowUpsPerObjective,
          maxDurationMinutes: cmd.maxDurationMinutes ?? d.limits.maxDurationMinutes,
        },
        limits: { maxCvChars: d.contextLimits.maxCvChars, maxJdChars: d.contextLimits.maxJdChars },
      }),
    );

    // ---- Steps 6-7: schema validation happened inside the gateway; a failure is
    // retryable and leaves the interview usable for another attempt.
    if (llm.kind === 'failed' || !llm.decision) {
      return this.failAttempt(interviewId, claim.operationId, 'AI_RESPONSE_UNUSABLE', (llm.errors ?? []).join('; '));
    }

    const decision = llm.decision as InitializationDecisionShape;

    // ---- Step 8: deterministic plan rules, including the C2 ref checks.
    const validation = validatePlan({
      objectives: decision.objectives.map((o) => ({
        ref: o.ref, phase: o.phase, requirementIds: o.requirement_ids,
        competencyTag: o.competency_tag, targetEvidenceCount: o.target_evidence_count,
      })),
      firstQuestionRef: decision.first_question.objective_ref,
      knownRequirementIds,
    });
    if (!validation.ok) {
      return this.failAttempt(interviewId, claim.operationId, validation.reason, validation.detail);
    }

    // ---- Step 8b: mint canonical ids and build the ref -> uuid map. The map is
    // in-memory for this call only; it is never persisted and never sent back to
    // the AI. From here on the AI only ever sees canonical UUIDs.
    const refToId = new Map<string, string>();
    const objectives = validation.objectives.map((o, index) => {
      const id = d.ids.next('obj');
      refToId.set(o.ref, id);
      return {
        id: asObjectiveId(id),
        aiRef: o.ref,
        ordinal: index,
        phase: o.phase,
        requirementIds: [...o.requirementIds],
        competencyTag: o.competencyTag,
        competencyLayer: o.competencyLayer,
        targetEvidenceCount: o.targetEvidenceCountClamped,
        status: 'IN_PROGRESS' as const,
      };
    });

    // Rewrite the first question's reference to the canonical id.
    const firstObjectiveId = refToId.get(decision.first_question.objective_ref);
    if (!firstObjectiveId) {
      return this.failAttempt(interviewId, claim.operationId, 'UNKNOWN_FIRST_QUESTION_REF', decision.first_question.objective_ref);
    }
    const firstObjective = objectives.find((o) => String(o.id) === firstObjectiveId);
    // Only the objective the first question targets starts IN_PROGRESS; the rest
    // stay PENDING until a question is actually presented for them (B5).
    for (const o of objectives) {
      if (String(o.id) !== firstObjectiveId) (o as { status: string }).status = 'PENDING';
    }

    const questionId = d.ids.next('q');
    const audit: AuditIntent[] = [
      auditIntent('AI_CALL', undefined, {
        mode: 'initialization',
        objectivesProposed: decision.objectives.length,
        operationalReasoning: decision.operational_reasoning,
      }),
      auditIntent('STATE_TRANSITION', 'PLAN_ACCEPTED', {
        from: 'PRE_INTERVIEW_ANALYSIS', to: 'OPENING', objectiveCount: objectives.length,
      }),
    ];

    // ---- Steps 9-11 (TX2): plan, first question, state, audit and the operation
    // result all commit together. A partial plan is never persisted.
    const body: CreateInterviewBody = {
      interviewId,
      status: 'OPENING',
      question: { id: questionId, text: decision.first_question.text },
      message: decision.candidate_message,
    };

    const iid = interviewId;
    await d.uow.run(async (tx) => {
      await d.plan.insertPlan(iid, 1, nowIso, tx);
      for (const o of objectives) {
        await d.plan.insertObjective(iid, o as InterviewObjective & { aiRef: string; ordinal: number }, tx);
      }
      await d.questions.insert(
        {
          id: questionId,
          interviewId: iid,
          objectiveId: asObjectiveId(firstObjectiveId),
          // Node sets the phase from the objective's plan assignment, never from
          // a field the AI could have drifted.
          phase: firstObjective?.phase ?? 'OPENING',
          text: decision.first_question.text,
          presentedAt: nowIso,
          sequenceNumber: 1,
          competencyTag: decision.first_question.competency,
          questionType: decision.first_question.question_type,
        },
        tx,
      );
      await d.state.insert(
        {
          interviewId: iid,
          currentPhase: firstObjective?.phase ?? 'OPENING',
          currentObjectiveId: asObjectiveId(firstObjectiveId),
          questionsAskedCount: 1,
          followUpsByObjective: {},
          elapsedActiveInterviewSeconds: 0,
          phaseElapsedSeconds: {},
          lastActivityAt: nowIso,
          unresolvedGapIds: [],
          lastQuestionId: questionId,
          version: 0,
          updatedAt: nowIso,
        },
        tx,
      );
      await d.assessments.seedRequirementRows(iid, [...knownRequirementIds], tx);
      // startedAt is set here, from the first question's presentedAt (B4).
      await d.interviews.markStarted(iid, 'OPENING', nowIso, tx);
      await d.audit.write(iid, audit, tx);
      await d.operations.succeed(claim.operationId, 201, body as unknown as Record<string, unknown>, tx);
      return true;
    });

    return { kind: 'ok', status: 201, body };
  }

  /**
   * A failed attempt leaves the interview in ERROR with its inputs intact, so a
   * replay of the same Idempotency-Key can re-run the AI-touching steps without
   * re-entering data. Nothing partially usable is created: no plan, no question,
   * no InterviewState — so the interview can never be answered.
   */
  private async failAttempt(
    interviewId: string, operationId: string, reason: PlanRejectionReason | 'AI_RESPONSE_UNUSABLE', detail: string,
  ): Promise<CreateInterviewResult> {
    await this.d.audit.writeDetached(interviewId, [
      auditIntent('VALIDATION_FAILURE', reason, { detail }),
    ]);
    await this.d.interviews.setStatus(interviewId, 'ERROR', this.d.clock.now().toISOString());
    await this.d.operations.fail(operationId, true);
    return { kind: 'error', status: 422, code: reason, detail };
  }
}
