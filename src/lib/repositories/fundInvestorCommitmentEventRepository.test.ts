import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundInvestorCommitmentEventRepository } from './fundInvestorCommitmentEventRepository';

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

describe('FundInvestorCommitmentEventRepository', () => {
  let mockDb: MockDb;
  let repo: FundInvestorCommitmentEventRepository;

  beforeEach(() => {
    mockDb = {
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
    repo = new FundInvestorCommitmentEventRepository(mockDb as never, 'workspace-1');
  });

  it('findAll filters by workspace and unwraps joined rows', async () => {
    const rows = [
      { event: { id: 'e1', fund_id: 'f1', holding_entity_id: 'h1', amount: 100 } },
      { event: { id: 'e2', fund_id: 'f1', holding_entity_id: 'h2', amount: 200 } },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findAll({ fundId: 'f1' });

    expect(result).toEqual([
      { id: 'e1', fund_id: 'f1', holding_entity_id: 'h1', amount: 100 },
      { id: 'e2', fund_id: 'f1', holding_entity_id: 'h2', amount: 200 },
    ]);
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
  });

  it('findByFundAndHoldingEntity returns events for that pair', async () => {
    const rows = [
      { event: { id: 'e1', fund_id: 'f1', holding_entity_id: 'h1', amount: 100 } },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByFundAndHoldingEntity('f1', 'h1');
    expect(result).toEqual([rows[0].event]);
  });

  it('findByTransferGroupId returns events sharing the group id', async () => {
    const rows = [
      { event: { id: 'e1', transfer_group_id: 'tg1', event_type: 'transfer_out' } },
      { event: { id: 'e2', transfer_group_id: 'tg1', event_type: 'transfer_in' } },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByTransferGroupId('tg1');
    expect(result).toEqual([rows[0].event, rows[1].event]);
  });

  it('findById returns single event when found', async () => {
    const event = { id: 'e1', fund_id: 'f1', amount: 100 };
    mockDb.limit.mockResolvedValueOnce([{ event }]);

    const result = await repo.findById('e1');
    expect(result).toEqual(event);
  });

  it('insert adds a record and returns it', async () => {
    const event = { id: 'e1', fund_id: 'f1', holding_entity_id: 'h1', amount: 100 };
    mockDb.returning.mockResolvedValueOnce([event]);

    const result = await repo.insert({
      fund_id: 'f1',
      holding_entity_id: 'h1',
      effective_date: '2026-01-01',
      event_type: 'initial_commitment',
      amount: 100,
    } as never);

    expect(result).toEqual(event);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('update modifies a record', async () => {
    const event = { id: 'e1', amount: 150 };
    mockDb.returning.mockResolvedValueOnce([event]);

    const result = await repo.update('e1', { amount: 150 });
    expect(result).toEqual(event);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('delete removes a record', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);
    await repo.delete('e1');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('deleteByTransferGroupId removes records by transfer group', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);
    await repo.deleteByTransferGroupId('tg1');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });
});
