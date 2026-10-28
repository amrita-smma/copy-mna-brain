import { describe, it, expect } from 'vitest';
import { PgTransaction } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/repositories';
import { queryAll } from './queryAll';

/** Tracks how many tasks are in flight at once. */
function makeTasks(count: number) {
  let inFlight = 0;
  let maxInFlight = 0;
  const tasks = Array.from({ length: count }, (_, i) => async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return i;
  });
  return { tasks, maxInFlight: () => maxInFlight };
}

const tx = Object.create(PgTransaction.prototype) as DbClient;
const pooledDb = {} as DbClient;

describe('queryAll', () => {
  it('runs tasks one at a time on a transaction, preserving result order', async () => {
    const { tasks, maxInFlight } = makeTasks(4);
    await expect(queryAll(tx, tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(maxInFlight()).toBe(1);
  });

  it('runs tasks concurrently on the pooled db', async () => {
    const { tasks, maxInFlight } = makeTasks(4);
    await expect(queryAll(pooledDb, tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(maxInFlight()).toBe(4);
  });

  it('runs tasks concurrently when no executor is given', async () => {
    const { tasks, maxInFlight } = makeTasks(3);
    await expect(queryAll(undefined, tasks)).resolves.toEqual([0, 1, 2]);
    expect(maxInFlight()).toBe(3);
  });

  it('does not start later tasks after an earlier one rejects on a transaction', async () => {
    let started = 0;
    const result = queryAll(tx, [
      async () => {
        started++;
        throw new Error('boom');
      },
      async () => {
        started++;
        return 1;
      },
    ]);
    await expect(result).rejects.toThrow('boom');
    expect(started).toBe(1);
  });
});
