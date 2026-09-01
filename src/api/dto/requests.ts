/**
 * Inbound request validation — Zod at the API layer, before any DB write or LLM
 * call. Rejection here costs nothing: no interview row, no provider spend.
 */
import { z } from 'zod';

const MAX_CV = 50_000;
const MAX_JD = 20_000;
const MAX_ANSWER = 20_000;

export const createInterviewSchema = z.object({
  candidate: z.object({
    fullName: z.string().min(1).max(200),
    cvRawText: z.string().min(1).max(MAX_CV),
  }),
  position: z.object({
    title: z.string().min(1).max(200),
    jobDescription: z.string().min(1).max(MAX_JD),
    companyContext: z.string().max(MAX_JD).optional(),
    organizationalValues: z.string().max(MAX_JD).optional(),
  }),
  requirements: z
    .array(
      z.object({
        label: z.string().min(1).max(300),
        description: z.string().max(2000).optional(),
        priority: z.enum(['MUST_HAVE', 'NICE_TO_HAVE']),
        competencyTag: z.string().min(1).max(100),
        // B1: recruiter configuration only, never inferred from priority.
        criticalGate: z.boolean().optional(),
      }),
    )
    .min(1),
  maxDurationMinutes: z.number().int().positive().max(300).optional(),
  maxQuestions: z.number().int().positive().max(200).optional(),
  maxFollowUpsPerObjective: z.number().int().min(0).max(10).optional(),
})
  // At least one MUST_HAVE, per ARCHITECTURE.md §11 validation.
  .refine((v) => v.requirements.some((r) => r.priority === 'MUST_HAVE'), {
    message: 'at least one MUST_HAVE requirement is required',
    path: ['requirements'],
  });

export const submitResponseSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1).max(MAX_ANSWER),
  idempotencyKey: z.string().min(1).max(200),
});

export type CreateInterviewRequest = z.infer<typeof createInterviewSchema>;
export type SubmitResponseRequest = z.infer<typeof submitResponseSchema>;
