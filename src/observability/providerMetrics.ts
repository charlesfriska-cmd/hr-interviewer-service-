/**
 * Provider call observability.
 *
 * Records safe structured metadata for every real AI call. Deliberately absent:
 * CV text, candidate answers, question or message text, secrets, and model
 * reasoning. Token counts are recorded as null — "unavailable" — when the
 * provider did not report them, never fabricated.
 */
import type { ProviderCallMetrics } from '../llm/providers/claude/ClaudeProvider.ts';

export interface StructuredLogger {
  info(event: string, fields: Record<string, unknown>): void;
}

/** Default logger: one JSON line per call, no free text interpolation. */
export const consoleLogger: StructuredLogger = {
  info(event, fields) {
    process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
  },
};

export class ProviderMetricsRecorder {
  public readonly calls: ProviderCallMetrics[] = [];

  constructor(
    private readonly logger: StructuredLogger = consoleLogger,
    private readonly retain = 0,
  ) {}

  record(metrics: ProviderCallMetrics): void {
    if (this.retain > 0) {
      this.calls.push(metrics);
      if (this.calls.length > this.retain) this.calls.shift();
    }
    this.logger.info('llm.call', {
      interviewId: metrics.interviewId,
      mode: metrics.mode,
      provider: metrics.provider,
      model: metrics.model,
      promptVersion: metrics.promptVersion,
      correlationId: metrics.correlationId,
      durationMs: metrics.durationMs,
      attempts: metrics.attempts,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens,
      tokenUsage: metrics.totalTokens === null ? 'unavailable' : 'reported',
      schemaValid: metrics.schemaValid,
      ...(metrics.failureKind ? { failureKind: metrics.failureKind } : {}),
    });
  }
}

/** Audit payload for AuditEvent(type=AI_CALL) — the durable half of the record. */
export function auditPayloadFor(metrics: ProviderCallMetrics): Record<string, unknown> {
  return {
    provider: metrics.provider,
    model: metrics.model,
    promptVersion: metrics.promptVersion,
    correlationId: metrics.correlationId,
    durationMs: metrics.durationMs,
    attempts: metrics.attempts,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    totalTokens: metrics.totalTokens,
    schemaValid: metrics.schemaValid,
    ...(metrics.failureKind ? { failureKind: metrics.failureKind } : {}),
  };
}
