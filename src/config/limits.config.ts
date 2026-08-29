/**
 * Interview limits and operational timing.
 *
 * Deliberately separate from scoring.config.ts: SCORING_FRAMEWORK.md v3 §9 states
 * maxCandidateResponseWindowSeconds and sessionIdleTimeoutMinutes "live on
 * Interview/application deployment config, not here — they are timing config, not
 * scoring config". processingLeaseDurationSeconds (API_CONTRACT.md v3 §5.1) is
 * likewise deployment configuration.
 *
 * The three global interview limits carry no value in any specification; the
 * defaults below implement INTERVIEW_FRAMEWORK.md §9's "Standard" preset and are
 * recorded as amendment A4 in docs/AMENDMENTS.md.
 */

export const INTERVIEW_LIMIT_DEFAULTS = {
  /** Bounds ACTIVE interview time, never wall-clock since creation (B4). */
  maxDurationMinutes: 50,
  maxQuestions: 24,
  maxFollowUpsPerObjective: 2,

  /**
   * B4 — per-turn clamp on turnActiveSeconds. A candidate who leaves a tab open
   * for 45 minutes still consumes only this much budget for that turn, which is
   * what stops idle time being laundered into active time.
   */
  maxCandidateResponseWindowSeconds: 600,

  /**
   * B4 — inactivity window measured from lastActivityAt. Independent of
   * maxDurationMinutes: a session can be well inside its active-time budget and
   * still idle-expire.
   */
  sessionIdleTimeoutMinutes: 120,
} as const;

/**
 * B3 — API_CONTRACT.md v3 §5.1 specifies this as "a fixed constant sized
 * comfortably above the LLMRequest.timeoutMs plus adapter retry budget", so a
 * lease never expires while a request is genuinely in flight but reliably
 * expires after a crashed attempt.
 *
 * Derivation: llm.timeoutMs (60s) x (1 initial + 2 adapter transport retries)
 * x (1 initial + 1 orchestrator schema retry) = 360s, plus 120s margin.
 */
export const OPERATION_CONFIG = {
  processingLeaseDurationSeconds: 480,
  /** Overall idempotency TTL, unchanged from v2 (API_CONTRACT.md §5). */
  operationTtlHours: 24,
  /** Create-flow attempt cap before FAILED_FINAL (API_CONTRACT.md §5 step 6). */
  maxCreateAttempts: 3,
} as const;

export const LLM_CONFIG_DEFAULTS = {
  timeoutMs: 60_000,
  temperature: 0.3,
  maxOutputTokens: 4096,
  /** Adapter-level transport retries only; schema retries are orchestrator-level. */
  maxTransportRetries: 2,
  /** Orchestrator-level corrective retry after an Ajv failure. */
  maxSchemaRetries: 1,
} as const;
