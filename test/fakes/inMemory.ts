/**
 * In-memory port implementations for pipeline tests.
 *
 * These exercise the production wiring — the pipeline depends only on the ports,
 * so nothing here is a parallel code path.
 */
import { classifyGap } from '../../src/domain/gaps/classification.ts';
import type { GapIntent } from '../../src/domain/gaps/reconcile.ts';
import {
  asObjectiveId,
  type CandidateResponse,
  type Evidence,
  type EvidenceGap,
  type Interview,
  type InterviewObjective,
  type InterviewState,
  type ObjectiveId,
  type Question,
} from '../../src/domain/types/entities.ts';
import type {
  CoverageLevel,
  EvidenceStrength,
  ObjectiveStatus,
} from '../../src/domain/types/enums.ts';
import type { AuditIntent } from '../../src/domain/audit/auditIntent.ts';
import type * as P from '../../src/application/ports/ports.ts';

export class FakeClock implements P.Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advanceSeconds(s: number): void {
    this.current = new Date(this.current.getTime() + s * 1000);
  }
}

export class SeqIds implements P.IdGenerator {
  private n = 0;
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.n}`;
  }
}

export class FakeUow implements P.UnitOfWork {
  public commits = 0;
  async run<T>(fn: (tx: P.TxScope) => Promise<T>): Promise<T> {
    const r = await fn({ id: `tx_${this.commits}` });
    this.commits += 1;
    return r;
  }
}

export class FakeOperations implements P.OperationStore {
  public claims: P.OperationClaim[] = [];
  public succeeded: Array<{ id: string; body: Record<string, unknown> }> = [];
  public failed: Array<{ id: string; retryable: boolean }> = [];
  private next: P.OperationClaim = { kind: 'proceed', operationId: 'op_1', attempt: 1, resuming: false };

  setNext(c: P.OperationClaim): void {
    this.next = c;
  }
  async claim(): Promise<P.OperationClaim> {
    this.claims.push(this.next);
    return this.next;
  }
  async succeed(id: string, _s: number, body: Record<string, unknown>): Promise<void> {
    this.succeeded.push({ id, body });
  }
  async fail(id: string, retryable: boolean): Promise<void> {
    this.failed.push({ id, retryable });
  }
}

export class FakeWorld {
  interview: Interview;
  state: InterviewState;
  objectives: InterviewObjective[] = [];
  questions: Question[] = [];
  responses: CandidateResponse[] = [];
  evidence: Evidence[] = [];
  gaps: EvidenceGap[] = [];
  audits: AuditIntent[] = [];
  coverage: CoverageLevel = 'COVERED';
  casShouldFail = false;

  constructor(overrides: { interview?: Partial<Interview>; state?: Partial<InterviewState> } = {}) {
    this.interview = {
      id: 'int_1',
      candidateId: 'cand_1',
      positionId: 'pos_1',
      status: 'COMPETENCY_DEEP_DIVE',
      createdAt: '2026-01-01T09:00:00Z',
      startedAt: '2026-01-01T09:05:00Z',
      updatedAt: '2026-01-01T09:05:00Z',
      maxDurationMinutes: 50,
      maxQuestions: 24,
      maxFollowUpsPerObjective: 2,
      maxCandidateResponseWindowSeconds: 600,
      sessionIdleTimeoutMinutes: 120,
      ...overrides.interview,
    };
    this.state = {
      interviewId: 'int_1',
      currentPhase: 'COMPETENCY_DEEP_DIVE',
      currentObjectiveId: asObjectiveId('obj_1'),
      questionsAskedCount: 3,
      followUpsByObjective: {},
      elapsedActiveInterviewSeconds: 300,
      phaseElapsedSeconds: {},
      lastActivityAt: '2026-01-01T09:10:00Z',
      unresolvedGapIds: [],
      lastQuestionId: 'q_existing',
      version: 7,
      updatedAt: '2026-01-01T09:10:00Z',
      ...overrides.state,
    };
  }

  objective(over: Partial<InterviewObjective> = {}): InterviewObjective {
    const o: InterviewObjective = {
      id: asObjectiveId('obj_1'),
      phase: 'COMPETENCY_DEEP_DIVE',
      requirementIds: ['req_1'],
      competencyTag: 'system_design',
      competencyLayer: 'POSITION_SPECIFIC',
      targetEvidenceCount: 1,
      status: 'IN_PROGRESS',
      ...over,
    };
    this.objectives.push(o);
    return o;
  }

  question(over: Partial<Question> = {}): Question {
    const q: Question = {
      id: 'q_existing',
      interviewId: 'int_1',
      objectiveId: asObjectiveId('obj_1'),
      phase: 'COMPETENCY_DEEP_DIVE',
      text: 'Tell me about that migration.',
      presentedAt: '2026-01-01T09:08:00Z',
      sequenceNumber: 3,
      competencyTag: 'system_design',
      questionType: 'behavioral',
      ...over,
    };
    this.questions.push(q);
    return q;
  }

  gap(gapType: EvidenceGap['gapType'], id = `gap_${gapType}`): EvidenceGap {
    const g: EvidenceGap = {
      id,
      interviewId: 'int_1',
      objectiveId: asObjectiveId('obj_1'),
      gapType,
      description: 'missing element',
      status: 'OPEN',
      createdAt: '2026-01-01T09:08:00Z',
      resolvedAt: null,
    };
    this.gaps.push(g);
    return g;
  }

  // ---- ports
  interviews: P.InterviewRepository = {
    load: async (id) => (id === this.interview.id ? this.interview : null),
  };

  stateRepo: P.InterviewStateRepository = {
    load: async () => this.state,
    compareAndSwap: async (next, expected) => {
      if (this.casShouldFail || this.state.version !== expected) return false;
      this.state = next;
      return true;
    },
  };

  plan: P.PlanRepository = {
    objectives: async () => this.objectives,
    mustHaveObjectiveIds: async () =>
      this.objectives.filter((o) => o.requirementIds.length > 0).map((o) => String(o.id)),
    setObjectiveStatus: async (_i, objectiveId: ObjectiveId, status: ObjectiveStatus) => {
      const o = this.objectives.find((x) => x.id === objectiveId);
      if (o) o.status = status;
    },
  };

  questionRepo: P.QuestionRepository = {
    load: async (id) => this.questions.find((q) => q.id === id) ?? null,
    insert: async (q) => {
      this.questions.push(q);
    },
    countForObjective: async (_i, objectiveId) =>
      this.questions.filter((q) => q.objectiveId === objectiveId).length,
  };

  responseRepo: P.CandidateResponseRepository = {
    insertDurable: async (r) => {
      this.responses.push(r);
    },
    findByQuestion: async (qid) => this.responses.find((r) => r.questionId === qid) ?? null,
  };

  evidenceRepo: P.EvidenceRepository = {
    insertMany: async (rows) => {
      this.evidence.push(...rows);
    },
    strengthsForObjective: async (_i, objective) =>
      this.evidence
        .filter((e) => e.competencyTag === objective.competencyTag)
        .map((e) => e.strength) as EvidenceStrength[],
  };

  gapRepo: P.EvidenceGapRepository = {
    openForObjective: async (_i, objectiveId) =>
      this.gaps.filter((g) => g.objectiveId === objectiveId && g.status === 'OPEN'),
    apply: async (intents: readonly GapIntent[]) => {
      for (const i of intents) {
        if (i.kind === 'INSERT') {
          this.gaps.push({
            id: `gap_${i.gapType}`,
            interviewId: 'int_1',
            objectiveId: i.objectiveId,
            gapType: i.gapType,
            description: i.description,
            status: 'OPEN',
            createdAt: '2026-01-01T09:11:00Z',
            resolvedAt: null,
          });
        } else if (i.kind === 'REFRESH_DESCRIPTION') {
          const g = this.gaps.find((x) => x.id === i.gapId);
          if (g) g.description = i.description;
        } else if (i.kind === 'RESOLVE') {
          const g = this.gaps.find((x) => x.id === i.gapId);
          if (g) {
            g.status = 'RESOLVED';
            g.resolvedAt = '2026-01-01T09:11:00Z';
          }
        }
      }
    },
    autoResolve: async (ids) => {
      for (const id of ids) {
        const g = this.gaps.find((x) => x.id === id);
        if (g) {
          g.status = 'RESOLVED';
          g.resolvedAt = '2026-01-01T09:11:00Z';
        }
      }
    },
  };

  assessmentRepo: P.AssessmentRepository = {
    applyUpdates: async () => {},
    coverageForObjective: async () => this.coverage,
  };

  auditWriter: P.AuditWriter = {
    write: async (_i, intents) => {
      this.audits.push(...intents);
    },
    writeDetached: async (_i, intents) => {
      this.audits.push(...intents);
    },
  };

  auditRules(): string[] {
    return this.audits.map((a) => a.rule ?? a.type);
  }

  openGapTypes(): string[] {
    return this.gaps.filter((g) => g.status === 'OPEN').map((g) => g.gapType);
  }
}

export const passthroughSafety: P.SafetyScanner = {
  scan: (text) => ({ text, matched: false }),
};

export const denylistSafety = (term: string): P.SafetyScanner => ({
  scan: (text) =>
    text.toLowerCase().includes(term)
      ? { text: text.replace(new RegExp(term, 'gi'), '[redacted]'), matched: true }
      : { text, matched: false },
});

export class FakeLLM implements P.LLMGateway {
  constructor(private result: P.LLMTurnResult) {}
  public calls = 0;
  async runTurn(): Promise<P.LLMTurnResult> {
    this.calls += 1;
    return this.result;
  }
}

export { classifyGap };
