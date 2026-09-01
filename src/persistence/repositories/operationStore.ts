/**
 * TurnOperation store — API_CONTRACT.md v3 §5, including B3's renewable lease.
 *
 * All six lookup outcomes are resolved here so no pipeline branches on `status`
 * itself. The database row is the only lock: no application-instance-local memory
 * and no new infrastructure component.
 */
import type pg from 'pg';
import { exec } from '../db/pool.ts';
import { OPERATION_CONFIG } from '../../config/limits.config.ts';
import type { OperationClaim, OperationStore, TxScope } from '../../application/ports/ports.ts';

export interface ClaimInput {
  readonly scope: 'interview_create' | 'interview_response';
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly interviewId?: string | null;
  readonly questionId?: string | null;
  readonly maxAttempts?: number;
}

export class PgOperationStore implements OperationStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseSeconds: number = OPERATION_CONFIG.processingLeaseDurationSeconds,
  ) {}

  async claim(input: ClaimInput): Promise<OperationClaim> {
    const now = this.now();
    const leaseExpiry = new Date(now.getTime() + this.leaseSeconds * 1000);
    const isCreate = input.scope === 'interview_create';
    const maxAttempts = input.maxAttempts ?? OPERATION_CONFIG.maxCreateAttempts;

    const existing = await this.find(input);

    if (!existing) {
      const id = `op_${input.scope}_${input.idempotencyKey}`;
      const expiresAt = new Date(now.getTime() + OPERATION_CONFIG.operationTtlHours * 3600 * 1000);
      try {
        await this.pool.query(
          `INSERT INTO turn_operations (id, scope, idempotency_key, request_hash, interview_id,
             question_id, status, attempt_count, processing_started_at,
             processing_lease_expires_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,'PROCESSING',1,$7,$8,$9)`,
          [id, input.scope, input.idempotencyKey, input.requestHash,
           input.interviewId ?? null, input.questionId ?? null,
           now.toISOString(), leaseExpiry.toISOString(), expiresAt.toISOString()],
        );
        return { kind: 'proceed', operationId: id, attempt: 1, resuming: false };
      } catch {
        // Lost an insert race; fall through to re-read whichever row won.
        const raced = await this.find(input);
        if (!raced) return { kind: 'conflict' };
        return this.classify(raced, input, now, leaseExpiry, isCreate, maxAttempts);
      }
    }

    return this.classify(existing, input, now, leaseExpiry, isCreate, maxAttempts);
  }

  private async classify(
    row: Record<string, unknown>,
    input: ClaimInput,
    now: Date,
    leaseExpiry: Date,
    isCreate: boolean,
    maxAttempts: number,
  ): Promise<OperationClaim> {
    const id = row.id as string;

    // A replayed key with a different body is a client error, never silently
    // served the wrong interview's result.
    if ((row.request_hash as string) !== input.requestHash) {
      return { kind: 'terminal', status: 422, body: { error: 'IDEMPOTENCY_KEY_REUSED' } };
    }

    const status = row.status as string;

    if (status === 'SUCCEEDED') {
      return {
        kind: 'replay',
        status: (row.response_status as number) ?? 200,
        body: (row.response_body as Record<string, unknown>) ?? {},
      };
    }

    if (status === 'FAILED_FINAL') {
      return {
        kind: 'terminal',
        status: (row.response_status as number) ?? 422,
        body: (row.response_body as Record<string, unknown>) ?? null,
      };
    }

    if (status === 'PROCESSING') {
      const leaseExpiresAt = row.processing_lease_expires_at as Date | null;
      const leaseValid = leaseExpiresAt !== null && new Date(leaseExpiresAt).getTime() > now.getTime();
      // Lease still valid: a genuinely concurrent duplicate is in flight.
      if (leaseValid) return { kind: 'conflict' };

      // B3: expired lease means the prior attempt was abandoned (crash, dropped
      // connection). Reclaim with a single conditional update so a concurrent
      // reclaimer cannot also believe it holds the lease.
      const { rowCount } = await this.pool.query(
        `UPDATE turn_operations
            SET attempt_count = attempt_count + 1, processing_started_at = $2,
                processing_lease_expires_at = $3, updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING' AND processing_lease_expires_at < $2`,
        [id, now.toISOString(), leaseExpiry.toISOString()],
      );
      if ((rowCount ?? 0) === 0) {
        // Someone else reclaimed first, or the original attempt completed.
        const refreshed = await this.find(input);
        if (!refreshed) return { kind: 'conflict' };
        if ((refreshed.status as string) === 'PROCESSING') return { kind: 'conflict' };
        return this.classify(refreshed, input, now, leaseExpiry, isCreate, maxAttempts);
      }
      return {
        kind: 'proceed',
        operationId: id,
        attempt: ((row.attempt_count as number) ?? 1) + 1,
        resuming: true,
      };
    }

    // FAILED_RETRYABLE — a resumable retry.
    const nextAttempt = ((row.attempt_count as number) ?? 1) + 1;
    if (isCreate && nextAttempt > maxAttempts) {
      await this.pool.query(
        `UPDATE turn_operations SET status = 'FAILED_FINAL', response_status = 422, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      return { kind: 'terminal', status: 422, body: { error: 'INITIALIZATION_FAILED' } };
    }
    await this.pool.query(
      `UPDATE turn_operations SET status = 'PROCESSING', attempt_count = $2,
         processing_started_at = $3, processing_lease_expires_at = $4, updated_at = now()
       WHERE id = $1`,
      [id, nextAttempt, now.toISOString(), leaseExpiry.toISOString()],
    );
    return { kind: 'proceed', operationId: id, attempt: nextAttempt, resuming: true };
  }

  private async find(input: ClaimInput): Promise<Record<string, unknown> | null> {
    const sql = input.scope === 'interview_create'
      ? `SELECT * FROM turn_operations WHERE scope = $1 AND idempotency_key = $2`
      : `SELECT * FROM turn_operations WHERE scope = $1 AND idempotency_key = $2
           AND interview_id IS NOT DISTINCT FROM $3 AND question_id IS NOT DISTINCT FROM $4`;
    const params = input.scope === 'interview_create'
      ? [input.scope, input.idempotencyKey]
      : [input.scope, input.idempotencyKey, input.interviewId ?? null, input.questionId ?? null];
    const { rows } = await this.pool.query(sql, params);
    return rows[0] ?? null;
  }

  /** Commits in the SAME transaction as the state change it describes, so the
   * record can never claim SUCCEEDED while the underlying writes rolled back. */
  async succeed(operationId: string, status: number, body: Record<string, unknown>, tx: TxScope): Promise<void> {
    await exec(this.pool, tx).query(
      `UPDATE turn_operations SET status = 'SUCCEEDED', response_status = $2, response_body = $3,
         processing_started_at = NULL, processing_lease_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [operationId, status, JSON.stringify(body)],
    );
  }

  async fail(operationId: string, retryable: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE turn_operations SET status = $2, processing_started_at = NULL,
         processing_lease_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [operationId, retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL'],
    );
  }

  /** Sets the interview id once the create flow has persisted its rows, so a
   * resumed attempt reuses them instead of re-inserting. */
  async attachInterview(operationId: string, interviewId: string): Promise<void> {
    await this.pool.query(
      `UPDATE turn_operations SET interview_id = $2, updated_at = now() WHERE id = $1`,
      [operationId, interviewId],
    );
  }

  async interviewIdFor(operationId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT interview_id FROM turn_operations WHERE id = $1`, [operationId],
    );
    return (rows[0]?.interview_id as string | null) ?? null;
  }
}
