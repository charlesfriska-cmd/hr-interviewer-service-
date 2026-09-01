/**
 * Composition root — the only file that names a concrete provider or repository.
 *
 * Switching to a real adapter is one env value and one new folder here; no
 * interview logic changes (ARCHITECTURE.md §17).
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { INTERVIEW_LIMIT_DEFAULTS, OPERATION_CONFIG } from '../config/limits.config.ts';
import { InitializationPipeline } from '../application/pipelines/InitializationPipeline.ts';
import { TurnPipeline } from '../application/pipelines/TurnPipeline.ts';
import { FinalizeInterviewService } from '../application/services/FinalizeInterviewService.ts';
import { PgUnitOfWork } from '../persistence/db/pool.ts';
import { createFieldCipher } from '../persistence/crypto/fieldCipher.ts';
import {
  PgAssessmentRepository,
  PgAuditWriter,
  PgCandidateResponseRepository,
  PgEvidenceGapRepository,
  PgEvidenceRepository,
  PgFinalAssessmentRepository,
  PgInterviewRepository,
  PgInterviewStateRepository,
  PgPlanRepository,
  PgQuestionRepository,
  PgReferenceRepository,
} from '../persistence/repositories/repositories.ts';
import { PgOperationStore } from '../persistence/repositories/operationStore.ts';
import { ClaudeProvider } from '../llm/providers/claude/ClaudeProvider.ts';
import type { InterviewerProvider } from '../llm/providers/provider.ts';
import { MockHRInterviewerProvider } from '../llm/providers/mock/MockHRInterviewerProvider.ts';
import { ProviderMetricsRecorder } from '../observability/providerMetrics.ts';
import { resolveProviderConfig, type ResolvedProviderConfig } from '../config/provider.config.ts';
import { MVP_CALIBRATION_DEFAULTS } from '../config/scoring.config.ts';
import { phaseBudgetStatus } from '../domain/time/activeTime.ts';
import type { InterviewPhase } from '../domain/types/enums.ts';
import type { Clock, IdGenerator, SafetyScanner, TxScope } from '../application/ports/ports.ts';

export const requestHash = (body: unknown): string =>
  createHash('sha256').update(JSON.stringify(body)).digest('hex');

export const systemClock: Clock = { now: () => new Date() };
export const uuidIds: IdGenerator = { next: (prefix) => `${prefix}_${randomUUID()}` };

/**
 * MVP denylist backstop. Authored as reviewable config data; the policy of what
 * to do with a match lives with the caller, because the action differs by field
 * (redact in evidence, substitute wholesale in candidate_message).
 */
const DENYLIST_TERMS = [
  'maternity', 'paternity', 'pregnan', 'religio', 'ethnic', 'race',
  'disabilit', 'marital status', 'sexual orientation', 'political',
];

export const denylistScanner: SafetyScanner = {
  scan(text) {
    let out = text;
    let matched = false;
    for (const term of DENYLIST_TERMS) {
      const re = new RegExp(`\\b\\w*${term}\\w*\\b`, 'gi');
      if (re.test(out)) {
        matched = true;
        out = out.replace(re, '[redacted]');
      }
    }
    return { text: out, matched };
  },
};

export interface Container {
  readonly pool: pg.Pool;
  readonly initialization: InitializationPipeline;
  readonly turn: TurnPipeline;
  readonly finalize: FinalizeInterviewService;
  readonly operations: PgOperationStore;
  readonly interviews: PgInterviewRepository;
  readonly state: PgInterviewStateRepository;
  readonly questions: PgQuestionRepository;
  readonly finals: PgFinalAssessmentRepository;
  readonly audit: PgAuditWriter;
  readonly evidence: PgEvidenceRepository;
  readonly assessments: PgAssessmentRepository;
  readonly plan: PgPlanRepository;
  readonly provider: InterviewerProvider;
}

export interface ContainerOptions {
  readonly pool: pg.Pool;
  readonly provider: InterviewerProvider;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly encryptionKey?: Buffer;
  readonly leaseSeconds?: number;
  readonly safety?: SafetyScanner;
  readonly contextLimits?: { maxCvChars?: number; maxJdChars?: number; maxAnswerChars?: number };
}

export function buildContainer(opts: ContainerOptions): Container {
  const clock = opts.clock ?? systemClock;
  const ids = opts.ids ?? uuidIds;
  const cipher = createFieldCipher(opts.encryptionKey ?? Buffer.alloc(32, 7));
  const uow = new PgUnitOfWork(opts.pool);

  const interviews = new PgInterviewRepository(opts.pool);
  const reference = new PgReferenceRepository(opts.pool, cipher);
  const state = new PgInterviewStateRepository(opts.pool);
  const plan = new PgPlanRepository(opts.pool);
  const questions = new PgQuestionRepository(opts.pool);
  const responses = new PgCandidateResponseRepository(opts.pool, cipher);
  const evidence = new PgEvidenceRepository(opts.pool);
  const gaps = new PgEvidenceGapRepository(opts.pool);
  const assessments = new PgAssessmentRepository(opts.pool);
  const finals = new PgFinalAssessmentRepository(opts.pool);
  const audit = new PgAuditWriter(opts.pool);
  const operations = new PgOperationStore(
    opts.pool,
    () => clock.now(),
    opts.leaseSeconds ?? OPERATION_CONFIG.processingLeaseDurationSeconds,
  );

  const finalize = new FinalizeInterviewService({
    pool: opts.pool, uow, interviews, reference, plan, evidence, assessments, finals, audit,
  });

  const initialization = new InitializationPipeline({
    clock, ids, uow,
    operations: {
      claim: (i) => operations.claim(i),
      succeed: (id, s, b, tx) => operations.succeed(id, s, b, tx),
      fail: (id, r) => operations.fail(id, r),
      attachInterview: (id, iid) => operations.attachInterview(id, iid),
      interviewIdFor: (id) => operations.interviewIdFor(id),
    },
    interviews: {
      insert: (i, tx) => interviews.insert(i, tx),
      load: (id) => interviews.load(id),
      markStarted: (id, s, at, tx) => interviews.markStarted(id, s, at, tx),
      setStatus: (id, s, at, tx) => interviews.setStatus(id, s, at, tx),
    },
    reference: {
      insertCandidate: (c, tx) => reference.insertCandidate(c, tx),
      insertPosition: (p, tx) => reference.insertPosition(p, tx),
      insertRequirements: (pid, r, tx) => reference.insertRequirements(pid, r, tx),
      requirementsForInterview: (id) => reference.requirementsForInterview(id),
    },
    plan: {
      insertPlan: (id, v, at, tx) => plan.insertPlan(id, v, at, tx),
      insertObjective: (id, o, tx) => plan.insertObjective(id, o, tx),
    },
    questions: { insert: (q, tx) => questions.insert(q, tx) },
    state: { insert: (s, tx) => state.insert(s, tx) },
    assessments: { seedRequirementRows: (id, r, tx) => assessments.seedRequirementRows(id, r, tx) },
    audit: {
      write: (id, a, tx) => audit.write(id, a, tx),
      writeDetached: (id, a) => audit.writeDetached(id, a),
    },
    llm: {
      generate: (mode, payload) =>
        opts.provider.generate(mode, payload) as Promise<{
          kind: 'ok' | 'failed'; decision?: unknown; errors?: string[];
        }>,
    },
    limits: INTERVIEW_LIMIT_DEFAULTS,
    contextLimits: { maxCvChars: opts.contextLimits?.maxCvChars ?? 20_000,
                     maxJdChars: opts.contextLimits?.maxJdChars ?? 10_000 },
  });

  const turn = new TurnPipeline({
    clock, ids, uow,
    operations: {
      claim: (i) => operations.claim(i),
      succeed: (id, s, b, tx) => operations.succeed(id, s, b, tx),
      fail: (id, r) => operations.fail(id, r),
    },
    interviews, state, plan, questions, responses, evidence, gaps, assessments, audit,
    llm: {
      runTurn: (payload) =>
        opts.provider.generate('turn', payload) as Promise<{
          kind: 'ok' | 'failed'; decision?: unknown; errors?: string[];
        }>,
    },
    safety: opts.safety ?? denylistScanner,
    finalize: (interviewId: string, tx: TxScope) => finalize.finalize(interviewId, tx),
    contextLimits: { maxAnswerChars: opts.contextLimits?.maxAnswerChars ?? 6_000 },
    phaseBudgetStatus: (st, iv) =>
      phaseBudgetStatus(
        st.phaseElapsedSeconds[st.currentPhase as InterviewPhase] ?? 0,
        MVP_CALIBRATION_DEFAULTS.phaseSoftBudgetShare[
          st.currentPhase as keyof typeof MVP_CALIBRATION_DEFAULTS.phaseSoftBudgetShare
        ] ?? 0.2,
        iv.maxDurationMinutes,
      ),
  });

  return {
    pool: opts.pool, initialization, turn, finalize, operations, interviews, state,
    questions, finals, audit, evidence, assessments, plan, provider: opts.provider,
  };
}

/**
 * Provider selection. This is the single dependency-injection point named in
 * ARCHITECTURE.md §17 — swapping providers changes nothing in interview logic.
 */
export function buildProvider(
  config: ResolvedProviderConfig = resolveProviderConfig(),
  metrics = new ProviderMetricsRecorder(),
): InterviewerProvider {
  if (config.provider === 'claude') {
    return new ClaudeProvider(
      {
        apiKey: config.apiKey,
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.timeoutMs,
        maxTransportRetries: config.maxTransportRetries,
        maxSchemaRetries: config.maxSchemaRetries,
        effort: config.effort,
        temperature: config.temperature,
      },
      metrics,
    );
  }
  // Mock mode needs no credentials and stays available for tests and local
  // deterministic development.
  return new MockHRInterviewerProvider({ steps: [] });
}
