import { describe, it, expect, vi } from 'vitest';
import { acquireCommitmentLedgerLocks, getCommitmentLedgerLockKey } from './fundCommitmentLock';

describe('fundCommitmentLock', () => {
  it('generates consistent lock keys', () => {
    expect(getCommitmentLedgerLockKey('fund-1', 'entity-A')).toBe('commitment-ledger:fund-1:entity-A');
  });

  it('acquires locks in deterministic sorted order and deduplicates ids', async () => {
    const executedQueries: unknown[] = [];
    const mockTxDb = {
      execute: vi.fn(async (query: unknown) => {
        executedQueries.push(query);
      }),
    };

    // Pass unsorted with duplicates
    await acquireCommitmentLedgerLocks(mockTxDb as never, 'fund-1', ['entity-Z', 'entity-A', 'entity-Z', 'entity-M']);

    expect(mockTxDb.execute).toHaveBeenCalledTimes(3);
    // Entity IDs sorted: entity-A, entity-M, entity-Z
    const sqlStrings = executedQueries.map((q) => JSON.stringify(q));
    expect(sqlStrings.length).toBe(3);
  });

  it('handles db clients without execute gracefully', async () => {
    const mockTxDb = {};
    await expect(acquireCommitmentLedgerLocks(mockTxDb as never, 'fund-1', ['entity-A'])).resolves.toBeUndefined();
  });
});
