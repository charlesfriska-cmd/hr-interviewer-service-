/**
 * Connection pool and transaction scope.
 *
 * TxScope carries the pooled client, so a repository given a scope enlists in the
 * caller's transaction and one given none runs on the pool. That is what lets the
 * pipelines compose a multi-repository transaction without any repository knowing
 * about the others.
 */
import pg from 'pg';
import type { TxScope, UnitOfWork } from '../../application/ports/ports.ts';

export interface PgTxScope extends TxScope {
  readonly client: pg.PoolClient;
}

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Resolves the executor for a repository call: the tx client, or the pool. */
export function exec(pool: pg.Pool, tx?: TxScope): Queryable {
  return tx ? (tx as PgTxScope).client : pool;
}

export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: pg.Pool) {}

  async run<T>(fn: (tx: TxScope) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scope: PgTxScope = { id: 'tx', client };
      const result = await fn(scope);
      // A null result is the pipelines' signal that a CAS lost; roll back rather
      // than committing a half-applied decision.
      if (result === null) {
        await client.query('ROLLBACK');
        return result;
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
