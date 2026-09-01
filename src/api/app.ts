/**
 * HTTP layer. Controllers parse, authenticate the calling service, delegate, and
 * map the response. No interview logic lives here.
 *
 * Auth is service-to-service (C14): this service authenticates a backend, not a
 * person. candidateId/interviewId are business identifiers carrying no authority.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Container } from '../composition/container.ts';
import { requestHash } from '../composition/container.ts';
import { createInterviewSchema, submitResponseSchema } from './dto/requests.ts';
import { toInterviewStatusResponse, toResultResponse } from './dto/responses.ts';

export interface AppOptions {
  readonly container: Container;
  /** Shared secret presented by the calling application backend. */
  readonly serviceApiKey: string;
}

export function createApp(opts: AppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ---- service-to-service auth boundary
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-service-key') !== opts.serviceApiKey) {
      res.status(401).json({ error: 'UNAUTHENTICATED' });
      return;
    }
    next();
  });

  const c = opts.container;

  // ---- POST /interviews
  app.post('/interviews', async (req: Request, res: Response) => {
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) {
      res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
      return;
    }
    const parsed = createInterviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD', detail: parsed.error.issues });
      return;
    }

    const result = await c.initialization.create({
      idempotencyKey,
      requestHash: requestHash(parsed.data),
      candidate: parsed.data.candidate,
      position: parsed.data.position,
      requirements: parsed.data.requirements,
      maxDurationMinutes: parsed.data.maxDurationMinutes,
      maxQuestions: parsed.data.maxQuestions,
      maxFollowUpsPerObjective: parsed.data.maxFollowUpsPerObjective,
    });

    if (result.kind === 'error') {
      res.status(result.status).json({ error: result.code, ...(result.detail ? { detail: result.detail } : {}) });
      return;
    }
    res.status(result.status).json(result.body);
  });

  // ---- POST /interviews/:interviewId/responses
  app.post('/interviews/:interviewId/responses', async (req: Request, res: Response) => {
    const parsed = submitResponseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD', detail: parsed.error.issues });
      return;
    }
    const interviewId = req.params.interviewId as string;

    const result = await c.turn.submit({
      interviewId,
      questionId: parsed.data.questionId,
      answer: parsed.data.answer,
      idempotencyKey: parsed.data.idempotencyKey,
      requestHash: requestHash({ interviewId, ...parsed.data }),
    });

    if (result.kind === 'error') {
      res.status(result.status).json({ error: result.code });
      return;
    }
    res.status(result.status).json(result.body);
  });

  // ---- GET /interviews/:interviewId — session-safe state only
  app.get('/interviews/:interviewId', async (req: Request, res: Response) => {
    const interviewId = req.params.interviewId as string;
    const interview = await c.interviews.load(interviewId);
    if (!interview) {
      res.status(404).json({ error: 'INTERVIEW_NOT_FOUND' });
      return;
    }
    const state = await c.state.load(interviewId);
    if (!state) {
      res.status(404).json({ error: 'STATE_NOT_FOUND' });
      return;
    }
    // Resume works by re-showing the outstanding question; no in-memory session.
    const q = state.lastQuestionId ? await c.questions.load(state.lastQuestionId) : null;
    res.status(200).json(
      toInterviewStatusResponse(interview, state, q ? { id: q.id, text: q.text } : null),
    );
  });

  // ---- GET /interviews/:interviewId/result — recruiter-facing
  app.get('/interviews/:interviewId/result', async (req: Request, res: Response) => {
    const interviewId = req.params.interviewId as string;
    const interview = await c.interviews.load(interviewId);
    if (!interview) {
      res.status(404).json({ error: 'INTERVIEW_NOT_FOUND' });
      return;
    }
    if (interview.status !== 'COMPLETED') {
      res.status(409).json({ error: 'INTERVIEW_NOT_COMPLETED' });
      return;
    }
    const row = await c.finals.load(interviewId);
    if (!row) {
      res.status(404).json({ error: 'RESULT_NOT_FOUND' });
      return;
    }
    res.status(200).json(toResultResponse(row));
  });

  // Typed domain errors map here; an AI failure never reaches this handler,
  // because that path returns 200 with the fallback by design.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  });

  return app;
}
