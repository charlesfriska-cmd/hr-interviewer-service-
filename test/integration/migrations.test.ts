import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/persistence/db/migrate.ts';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgresql://hrsvc@localhost/postgres?host=/tmp&port=55432';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe('migrations run from a clean database', () => {
  it('creates the full schema and is idempotent on re-run', async () => {
    const dbName = `hrsvc_m_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const pool = new pg.Pool({ connectionString: ADMIN_URL.replace('/postgres?', `/${dbName}?`) });
    cleanup = async () => {
      await pool.end();
    };

    const applied = await migrate(pool, path.resolve('migrations'));
    expect(applied).toContain('0001_init');

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const required of [
      'interviews', 'candidates', 'positions', 'job_requirements', 'interview_objectives',
      'interview_state', 'questions', 'candidate_responses', 'evidence', 'evidence_gaps',
      'requirement_assessments', 'competency_assessments', 'final_assessments',
      'audit_events', 'turn_operations', 'interview_plans',
      'interview_objective_requirements', 'position_competency_weights',
    ]) {
      expect(names).toContain(required);
    }

    // A second run applies nothing — the runner is forward-only and idempotent.
    const again = await migrate(pool, path.resolve('migrations'));
    expect(again).toHaveLength(0);
  });

  it('enforces the constraints that carry a rule', async () => {
    const dbName = `hrsvc_c_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: ADMIN_URL.replace('/postgres?', `/${dbName}?`) });
    cleanup = async () => {
      await pool.end();
    };
    await migrate(pool, path.resolve('migrations'));

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    // C11 dedup: at most one OPEN gap per (objective, gapType), enforced by a
    // partial unique index rather than by application care.
    expect(names).toContain('evidence_gaps_open_unique');
    // A double-applied turn is impossible at the storage layer (A1).
    expect(names).toContain('questions_interview_sequence_unique');
    expect(names).toContain('candidate_responses_question_unique');
    // Idempotency uniqueness differs by scope (API_CONTRACT v3 §5).
    expect(names).toContain('turn_operations_create_key');
    expect(names).toContain('turn_operations_response_key');
  });
});
