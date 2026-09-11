import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlLedgerEntryRepository } from './flLedgerEntryRepository';
import type { DbClient } from './types';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  const mock: MockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    delete: vi.fn().mockReturnThis(),
  };
  return mock;
}

describe('FlLedgerEntryRepository', () => {
  let mockDb: MockDb;
  let repo: FlLedgerEntryRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlLedgerEntryRepository(mockDb as never);
  });

  describe('event mutation boundary', () => {
    it('does not expose direct ledger-entry updates', () => {
      expect(typeof (repo as { update?: unknown }).update).toBe('undefined');
      expect(typeof repo.deleteByIds).toBe('function');
      expect(typeof repo.deleteByBusinessEventId).toBe('function');
    });
  });

  describe('create and createMany', () => {
    it('creates a single ledger entry', async () => {
      const entry = {
        id: 'entry-1',
        position_id: 'pos-1',
        business_event_id: 'be-1',
        entry_date: '2026-01-01',
        entry_type: 'commitment',
        commitment_delta: '1000000.00000000',
        currency: 'USD',
      };
      mockDb.returning.mockResolvedValueOnce([entry]);

      const result = await repo.create(entry as never);
      expect(result).toEqual(entry);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('createMany returns empty array without hitting db when entries is empty', async () => {
      const result = await repo.createMany([]);
      expect(result).toEqual([]);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('createMany inserts multiple entries and uses supplied executor', async () => {
      const executorMock = createMockDb();
      const entries = [
        { id: 'e1', position_id: 'pos-1' },
        { id: 'e2', position_id: 'pos-2' },
      ];
      executorMock.returning.mockResolvedValueOnce(entries);

      const result = await repo.createMany(entries as never, executorMock as unknown as DbClient);
      expect(result).toEqual(entries);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns entry by id and workspace when found via join', async () => {
      const entry = { id: 'entry-1', position_id: 'pos-1' };
      mockDb.limit.mockResolvedValueOnce([{ entry }]);

      const result = await repo.findById('ws-1', 'entry-1');
      expect(result).toEqual(entry);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const entry = { id: 'entry-1', position_id: 'pos-1' };
      executorMock.limit.mockResolvedValueOnce([{ entry }]);

      const result = await repo.findById('ws-1', 'entry-1', executorMock as unknown as DbClient);
      expect(result).toEqual(entry);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(executorMock.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByBusinessEventId', () => {
    it('returns entries for specified business event joining business events table', async () => {
      const entries = [{ id: 'e1' }, { id: 'e2' }];
      mockDb.orderBy.mockResolvedValueOnce(entries.map((e) => ({ entry: e })));

      const result = await repo.findByBusinessEventId('ws-1', 'be-1');
      expect(result).toEqual(entries);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns all ledger entries in workspace joining positions table', async () => {
      const entries = [{ id: 'e1' }, { id: 'e2' }];
      mockDb.orderBy.mockResolvedValueOnce(entries.map((e) => ({ entry: e })));

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(entries);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const entries = [{ id: 'e1' }];
      executorMock.orderBy.mockResolvedValueOnce(entries.map((e) => ({ entry: e })));

      const result = await repo.findByWorkspaceId('ws-1', executorMock as unknown as DbClient);
      expect(result).toEqual(entries);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByPositionIds', () => {
    it('returns empty array without hitting db when positionIds is empty', async () => {
      const result = await repo.findByPositionIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('applies default limit 50 and orders by position_id, entry_date, id with position join', async () => {
      const entries = [{ id: 'e1', position_id: 'pos-1' }];
      mockDb.limit.mockResolvedValueOnce([{ entry: entries[0] }]);

      const result = await repo.findByPositionIds('ws-1', ['pos-1']);
      expect(result).toEqual(entries);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.limit).toHaveBeenCalledWith(50);
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    });

    it('caps limit at 200 when a larger limit is passed', async () => {
      const entries = [{ id: 'e1' }];
      mockDb.limit.mockResolvedValueOnce([{ entry: entries[0] }]);

      await repo.findByPositionIds('ws-1', ['pos-1'], { limit: 500 });
      expect(mockDb.limit).toHaveBeenCalledWith(200);
    });

    it('applies offset when provided', async () => {
      const entries = [{ id: 'e2' }];
      mockDb.offset.mockResolvedValueOnce([{ entry: entries[0] }]);

      await repo.findByPositionIds('ws-1', ['pos-1'], { limit: 10, offset: 20 });
      expect(mockDb.limit).toHaveBeenCalledWith(10);
      expect(mockDb.offset).toHaveBeenCalledWith(20);
    });
  });

  describe('findAllByPositionIds', () => {
    it('returns empty array without hitting db when positionIds is empty', async () => {
      const result = await repo.findAllByPositionIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns all matching entries without applying any limit or offset', async () => {
      const entries = Array.from({ length: 75 }, (_, i) => ({
        id: `e${i + 1}`,
        position_id: i < 40 ? 'pos-1' : 'pos-2',
        entry_date: '2023-01-01',
      }));
      mockDb.orderBy.mockResolvedValueOnce(entries.map((entry) => ({ entry })));

      const result = await repo.findAllByPositionIds('ws-1', ['pos-1', 'pos-2']);
      expect(result).toHaveLength(75);
      expect(result).toEqual(entries);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.limit).not.toHaveBeenCalled();
      expect(mockDb.offset).not.toHaveBeenCalled();
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('countByPositionIds', () => {
    it('returns 0 without hitting db when positionIds is empty', async () => {
      const result = await repo.countByPositionIds('ws-1', []);
      expect(result).toBe(0);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns total count for position ids with parent join', async () => {
      mockDb.where.mockResolvedValueOnce([{ count: 42 }]);

      const result = await repo.countByPositionIds('ws-1', ['pos-1', 'pos-2']);
      expect(result).toBe(42);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('sumDeltasByPositionIds', () => {
    it('returns empty array without hitting db when positionIds is empty', async () => {
      const result = await repo.sumDeltasByPositionIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('aggregates deltas grouped and ordered by position_id scoped through position join', async () => {
      const sums = [
        {
          position_id: 'pos-1',
          commitment_sum: '1000000.00000000',
          quantity_sum: '0.00000000',
          cash_sum: '-500000.00000000',
          contributed_sum: '500000.00000000',
        },
      ];
      mockDb.orderBy.mockResolvedValueOnce(sums);

      const result = await repo.sumDeltasByPositionIds('ws-1', ['pos-1']);
      expect(result).toEqual(sums);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.leftJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.groupBy).toHaveBeenCalledTimes(1);
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    });

    it('routes paid-in write-offs out of the valuation aggregate, retaining untyped valuations', async () => {
      mockDb.orderBy.mockResolvedValueOnce([]);
      await repo.sumDeltasByPositionIds('ws-1', ['pos-1']);
      const fields = mockDb.select.mock.calls[0][0];
      const dialect = new PgDialect();
      const paidIn = dialect.sqlToQuery(fields.paid_in_adjustment_sum);
      const valuation = dialect.sqlToQuery(fields.valuation_delta_sum);
      expect(paidIn.sql).toContain('FILTER (WHERE');
      expect(paidIn.sql).toContain("= 'adjustment'");
      expect(paidIn.params).toEqual(['paid_in_writeoff']);
      expect(valuation.sql).toContain('FILTER (WHERE NOT');
      // NULL subtype must remain a valuation instead of being lost to SQL NULL logic.
      expect(valuation.sql).toContain('IS NOT DISTINCT FROM');
      expect(valuation.params).toEqual(['paid_in_writeoff']);
    });

    it('supports asOfDate filter and executor threading', async () => {
      const executorMock = createMockDb();
      const sums = [
        {
          position_id: 'pos-1',
          commitment_sum: '1000000.00000000',
          quantity_sum: '0.00000000',
          cash_sum: '-250000.00000000',
          contributed_sum: '250000.00000000',
        },
      ];
      executorMock.orderBy.mockResolvedValueOnce(sums);

      const result = await repo.sumDeltasByPositionIds(
        'ws-1',
        ['pos-1'],
        '2026-03-31',
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(sums);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(executorMock.innerJoin).toHaveBeenCalledTimes(1);
      expect(executorMock.leftJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('constructs retained_proceeds_sum aggregate query including distribution entry type and cash_in_fund subtypes', async () => {
      mockDb.orderBy.mockResolvedValueOnce([]);

      await repo.sumDeltasByPositionIds('ws-1', ['pos-1']);

      expect(mockDb.select).toHaveBeenCalledTimes(1);
      const selectArg = mockDb.select.mock.calls[0][0];
      expect(selectArg).toHaveProperty('retained_proceeds_sum');

      const queryChunks = selectArg.retained_proceeds_sum?.queryChunks;
      expect(queryChunks).toBeDefined();

      const sqlText = queryChunks
        .map((chunk: any) =>
          typeof chunk === 'string'
            ? chunk
            : chunk?.name || chunk?.value?.name || (chunk && typeof chunk === 'object' && 'value' in chunk ? String(chunk.value) : '')
        )
        .join(' ');

      expect(sqlText).toMatch(/entry_type[\s\S]*IN\s*\([^)]*'distribution'[^)]*\)/);
      expect(sqlText).toContain('sell');
      expect(sqlText).toContain('redemption');
      expect(sqlText).toContain('distribution');
      expect(sqlText).toContain('divestment:cash_in_fund');
      expect(sqlText).toContain('cash_in_fund');
    });
  });

  describe('FlLedgerEntryRepository.deleteByIds', () => {
    it('returns without hitting the DB when the id list is empty', async () => {
      await repo.deleteByIds('ws-1', []);
      expect(mockDb.select).not.toHaveBeenCalled();
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it('deletes only workspace-scoped ids', async () => {
      mockDb.where.mockResolvedValueOnce([{ id: 'entry-1' }]);
      await repo.deleteByIds('ws-1', ['entry-1', 'other']);
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });
  });
});
