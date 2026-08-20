import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundHoldingEntityStakeRepository } from './fundHoldingEntityStakeRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

describe('FundHoldingEntityStakeRepository', () => {
  let mockDb: MockDb;
  let repo: FundHoldingEntityStakeRepository;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn(),
      delete: vi.fn().mockReturnThis(),
    };
    repo = new FundHoldingEntityStakeRepository(mockDb as never, 'workspace-1');
  });

  it('findAll unwraps joined stake rows scoped to the workspace', async () => {
    mockDb.where.mockResolvedValueOnce([
      { stake: { id: 's1', fund_id: 'f1', holding_entity_id: 'i1' } },
      { stake: { id: 's2', fund_id: 'f2', holding_entity_id: 'i1' } },
    ]);

    const result = await repo.findAll();

    expect(result).toEqual([
      { id: 's1', fund_id: 'f1', holding_entity_id: 'i1' },
      { id: 's2', fund_id: 'f2', holding_entity_id: 'i1' },
    ]);
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
  });

  it('findByFundHoldingEntity returns the matching row', async () => {
    const row = { id: 's1', fund_id: 'f1', holding_entity_id: 'i1' };
    mockDb.limit.mockResolvedValueOnce([{ stake: row }]);

    expect(await repo.findByFundHoldingEntity('f1', 'i1')).toEqual(row);
  });

  it('upsert deletes any existing (fund, holdingEntity) stake then inserts', async () => {
    const row = { id: 's1', fund_id: 'f1', holding_entity_id: 'i1', commitment_amount: 2_000_000 };
    // First call: select to preserve created_at
    mockDb.limit.mockResolvedValueOnce([{ created_at: '2026-01-01T00:00:00Z' }]);
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.upsert({
      fund_id: 'f1',
      holding_entity_id: 'i1',
      commitment_amount: 2_000_000,
    } as never);

    expect(result).toEqual(row);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('delete issues a delete', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);
    await repo.delete('s1');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });
});
