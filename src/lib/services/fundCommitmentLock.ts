import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/server/db';

export function getCommitmentLedgerLockKey(fundId: string, holdingEntityId: string): string {
  return `commitment-ledger:${fundId}:${holdingEntityId}`;
}

/**
 * Acquire PostgreSQL transaction-scoped advisory locks for one or more holding entities
 * within a fund. Holding entity IDs are deduplicated and sorted deterministically to prevent
 * deadlocks when locking multiple participants (e.g. transfer seller + buyer).
 */
export async function acquireCommitmentLedgerLocks(
  txDb: DbClient,
  fundId: string,
  holdingEntityIds: string[],
): Promise<void> {
  const uniqueSorted = Array.from(new Set(holdingEntityIds)).sort();
  for (const entityId of uniqueSorted) {
    const lockKey = getCommitmentLedgerLockKey(fundId, entityId);
    if (typeof (txDb as unknown as { execute?: unknown }).execute === 'function') {
      await (txDb as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
    }
  }
}
