/**
 * Active Interview Time vs Session Idle Time — INTERVIEW_STATE.md v3 §4b (B4).
 *
 * Two independent clocks; neither substitutes for the other.
 *  - ACTIVE_INTERVIEW_TIME  bounds maxDurationMinutes and the phase soft budgets.
 *  - SESSION_IDLE_TIME      decides only whether the session is idle-terminated.
 *
 * Idle time is never added to elapsedActiveInterviewSeconds and never consumes
 * phase or interview budget (DOMAIN_GLOSSARY: SESSION_IDLE_TIME).
 */

export interface TurnTimingInput {
  /** Question.presentedAt — the turn's clock start. */
  readonly presentedAt: Date;
  /** CandidateResponse.receivedAt — set at the durable pre-LLM-call write. */
  readonly receivedAt: Date;
  /** Interview.maxCandidateResponseWindowSeconds — the per-turn clamp. */
  readonly maxCandidateResponseWindowSeconds: number;
}

/**
 * turnActiveSeconds = min(receivedAt - presentedAt, maxCandidateResponseWindowSeconds)
 *
 * The clamp is what stops idle time being laundered into active time: a candidate
 * who takes 45 minutes over one question still consumes only the window.
 * A negative interval (clock skew) floors at zero rather than crediting budget back.
 */
export function computeTurnActiveSeconds(input: TurnTimingInput): number {
  const rawSeconds = (input.receivedAt.getTime() - input.presentedAt.getTime()) / 1000;
  const nonNegative = Math.max(0, rawSeconds);
  return Math.min(nonNegative, input.maxCandidateResponseWindowSeconds);
}

/** §4b step 5 — what the AI sees as constraints.remainingTimeMinutes. */
export function remainingTimeMinutes(
  elapsedActiveInterviewSeconds: number,
  maxDurationMinutes: number,
): number {
  return Math.max(0, maxDurationMinutes - elapsedActiveInterviewSeconds / 60);
}

/** §4 guardrail trigger — active time, never wall-clock since startedAt. */
export function isTimeExhausted(
  elapsedActiveInterviewSeconds: number,
  maxDurationMinutes: number,
): boolean {
  return elapsedActiveInterviewSeconds >= maxDurationMinutes * 60;
}

/**
 * §4b — the separate inactivity guardrail. Independent of active-time budget: a
 * session can be well within budget and still idle-expire, and reaching
 * maxDurationMinutes is handled by TIME_EXHAUSTED, never by this path.
 */
export function isSessionIdleExpired(
  now: Date,
  lastActivityAt: Date,
  sessionIdleTimeoutMinutes: number,
): boolean {
  const idleSeconds = (now.getTime() - lastActivityAt.getTime()) / 1000;
  return idleSeconds >= sessionIdleTimeoutMinutes * 60;
}

/** §4a — advisory signal only; never forces a phase transition (C15). */
export function phaseBudgetStatus(
  phaseElapsedSeconds: number,
  phaseShare: number,
  maxDurationMinutes: number,
): 'ON_TRACK' | 'OVER_BUDGET' {
  const allowance = maxDurationMinutes * 60 * phaseShare;
  return phaseElapsedSeconds > allowance ? 'OVER_BUDGET' : 'ON_TRACK';
}
