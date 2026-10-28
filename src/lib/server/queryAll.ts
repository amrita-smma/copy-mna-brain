import { PgTransaction } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/repositories';

/**
 * Run a batch of independent queries, concurrently when that is safe.
 *
 * A transaction is a single pg connection: `Promise.all` over queries on it
 * calls `client.query()` while another query is still running, which pg 8
 * queues with a DeprecationWarning and pg 9 removes. So when `executor` is a
 * transaction the tasks run one after another; otherwise (the pooled db, or
 * no executor) they run with `Promise.all`, each on its own pool connection.
 *
 * Tasks are thunks so no query starts before its turn.
 */
export async function queryAll<T extends readonly unknown[]>(
  executor: DbClient | undefined,
  tasks: { readonly [K in keyof T]: () => Promise<T[K]> },
): Promise<T> {
  const thunks = tasks as unknown as ReadonlyArray<() => Promise<unknown>>;
  if (!(executor instanceof PgTransaction)) {
    return (await Promise.all(thunks.map((task) => task()))) as unknown as T;
  }
  const results: unknown[] = [];
  for (const task of thunks) {
    results.push(await task());
  }
  return results as unknown as T;
}
