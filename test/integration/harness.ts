/**
 * Integration harness: a real Postgres database, migrated from clean, plus the
 * production container wired to the mock provider. No LLM credentials anywhere.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { migrate } from '../../src/persistence/db/migrate.ts';
import { buildContainer, type Container } from '../../src/composition/container.ts';
import { createApp } from '../../src/api/app.ts';
import {
  MockHRInterviewerProvider,
  type MockStep,
} from '../../src/llm/providers/mock/MockHRInterviewerProvider.ts';
import type { Clock, IdGenerator } from '../../src/application/ports/ports.ts';

export const SERVICE_KEY = 'test-service-key';
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://hrsvc@localhost/postgres?host=/tmp&port=55432';

export class TestClock implements Clock {
  constructor(public current: Date = new Date('2026-03-01T10:00:00Z')) {}
  now(): Date {
    return this.current;
  }
  advanceSeconds(s: number): void {
    this.current = new Date(this.current.getTime() + s * 1000);
  }
}

/**
 * Deterministic ids for assertions. The `-c` infix keeps canonical ids visibly
 * distinct from the AI's response-local refs (`obj_1`), so a test can prove the
 * ref -> UUID minting actually happened rather than coincidentally matching.
 */
export class SeqIds implements IdGenerator {
  private counters = new Map<string, number>();
  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-c${n}`;
  }
}

export interface Harness {
  readonly pool: pg.Pool;
  readonly container: Container;
  readonly app: ReturnType<typeof createApp>;
  readonly provider: MockHRInterviewerProvider;
  readonly clock: TestClock;
  close(): Promise<void>;
}

/** Each test gets its own database, migrated from clean. */
export async function createHarness(opts: {
  steps: readonly MockStep[];
  leaseSeconds?: number;
  clock?: TestClock;
} ): Promise<Harness> {
  const dbName = `hrsvc_t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: ADMIN_URL.replace('/postgres?', `/${dbName}?`) });
  await migrate(pool, path.resolve('migrations'));

  const clock = opts.clock ?? new TestClock();
  const provider = new MockHRInterviewerProvider({ steps: opts.steps });
  const container = buildContainer({
    pool,
    provider,
    clock,
    ids: new SeqIds(),
    ...(opts.leaseSeconds !== undefined ? { leaseSeconds: opts.leaseSeconds } : {}),
  });
  const app = createApp({ container, serviceApiKey: SERVICE_KEY });

  return {
    pool, container, app, provider, clock,
    close: async () => {
      await pool.end();
    },
  };
}

export const createBody = (over: Record<string, unknown> = {}) => ({
  candidate: { fullName: 'Alex Rivera', cvRawText: 'Ten years leading platform teams.' },
  position: { title: 'Staff Engineer', jobDescription: 'Own platform architecture.' },
  requirements: [
    { label: 'System design ownership', priority: 'MUST_HAVE', competencyTag: 'system_design', criticalGate: true },
    { label: 'Kubernetes familiarity', priority: 'NICE_TO_HAVE', competencyTag: 'infra' },
  ],
  ...over,
});
