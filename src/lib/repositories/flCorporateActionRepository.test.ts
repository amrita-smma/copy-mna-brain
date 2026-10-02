import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlCorporateActionRepository } from './flCorporateActionRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('FlCorporateActionRepository', () => {
  let db: MockDb;
  let repo: FlCorporateActionRepository;

  beforeEach(() => {
    db = createMockDb();
    repo = new FlCorporateActionRepository(db as never);
  });

  describe('FlCorporateActionRepository.createAction', () => {
    it('inserts the round and returns the created row', async () => {
      const round = { id: 'r1', workspace_id: 'ws-1', asset_id: 'a1' };
      db.returning.mockResolvedValueOnce([round]);

      const result = await repo.createAction({
        workspace_id: 'ws-1',
        asset_id: 'a1',
        action_date: '2025-06-01',
        currency: 'CNY',
        pre_money: '100',
        round_size: '10',
      });

      expect(result).toEqual(round);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('uses the supplied executor instead of the base client', async () => {
      const tx = createMockDb();
      tx.returning.mockResolvedValueOnce([{ id: 'r1' }]);

      await repo.createAction(
        {
          workspace_id: 'ws-1',
          asset_id: 'a1',
          action_date: '2025-06-01',
          currency: 'CNY',
          pre_money: '100',
          round_size: '10',
        },
        tx as never,
      );

      expect(tx.insert).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('FlCorporateActionRepository.findActionById', () => {
    it('returns the row when found and undefined otherwise', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'r1' }]).mockResolvedValueOnce([]);

      expect(await repo.findActionById('ws-1', 'r1')).toEqual({ id: 'r1' });
      expect(await repo.findActionById('ws-1', 'missing')).toBeUndefined();
    });
  });

  describe('FlCorporateActionRepository.findActionsByAssetIds', () => {
    it('returns [] without hitting the DB when the id list is empty', async () => {
      expect(await repo.findActionsByAssetIds('ws-1', [])).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('orders by asset first so callers can group in one pass', async () => {
      db.orderBy.mockResolvedValueOnce([{ id: 'r1', asset_id: 'a1' }]);

      const rows = await repo.findActionsByAssetIds('ws-1', ['a1', 'a2']);

      expect(rows).toEqual([{ id: 'r1', asset_id: 'a1' }]);
      expect(db.select).toHaveBeenCalledTimes(1);
      const orderArgs = db.orderBy.mock.calls[0];
      expect(orderArgs).toHaveLength(4);
    });
  });

  describe('FlCorporateActionRepository.findChangesByActionIds', () => {
    it('returns [] without hitting the DB when the id list is empty', async () => {
      expect(await repo.findChangesByActionIds('ws-1', [])).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('scopes through the parent round and unwraps the joined rows', async () => {
      db.orderBy.mockResolvedValueOnce([
        { participation: { id: 'pp1', corporate_action_id: 'r1' } },
        { participation: { id: 'pp2', corporate_action_id: 'r1' } },
      ]);

      const rows = await repo.findChangesByActionIds('ws-1', ['r1']);

      expect(rows).toEqual([
        { id: 'pp1', corporate_action_id: 'r1' },
        { id: 'pp2', corporate_action_id: 'r1' },
      ]);
      expect(db.innerJoin).toHaveBeenCalledTimes(1);
    });
  });

  describe('FlCorporateActionRepository.insertChanges', () => {
    it('returns [] without hitting the DB when there are no rows', async () => {
      expect(await repo.insertChanges([])).toEqual([]);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('inserts every row in a single statement', async () => {
      const rows = [
        { corporate_action_id: 'r1', position_id: 'p1', pct_before: '10', pct_after: '8' },
        { corporate_action_id: 'r1', position_id: 'p2', pct_before: '4', pct_after: '3' },
      ];
      db.returning.mockResolvedValueOnce(rows);

      await repo.insertChanges(rows);

      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.values).toHaveBeenCalledWith(rows);
    });
  });

  describe('FlCorporateActionRepository.updateAction', () => {
    it('sets updated_at alongside the given fields', async () => {
      db.returning.mockResolvedValueOnce([{ id: 'r1', label: 'Series B' }]);

      const row = await repo.updateAction('ws-1', 'r1', { label: 'Series B' });

      expect(row).toEqual({ id: 'r1', label: 'Series B' });
      const setArg = db.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.label).toBe('Series B');
      expect(setArg.updated_at).toBeDefined();
    });
  });

  describe('FlCorporateActionRepository.deleteAction', () => {
    it('issues a single delete', async () => {
      db.where.mockResolvedValueOnce(undefined);

      await repo.deleteAction('ws-1', 'r1');

      expect(db.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('FlCorporateActionRepository.deleteChangesByActionId', () => {
    it('issues a single delete', async () => {
      db.where.mockResolvedValueOnce(undefined);

      await repo.deleteChangesByActionId('r1');

      expect(db.delete).toHaveBeenCalledTimes(1);
    });
  });
});
