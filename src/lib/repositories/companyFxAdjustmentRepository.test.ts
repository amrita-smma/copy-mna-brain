import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanyFxAdjustmentRepository } from './companyFxAdjustmentRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  const db: MockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
  };
  db.transaction.mockImplementation(async (cb: (tx: MockDb) => Promise<void>) => cb(db));
  return db;
}

describe('CompanyFxAdjustmentRepository', () => {
  let mockDb: MockDb;
  let repo: CompanyFxAdjustmentRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new CompanyFxAdjustmentRepository(mockDb as never, 'workspace-a');
  });

  it('findByCompany scopes the lookup via the companies subquery', async () => {
    const rows = [{ company_id: 'company-1', fiscal_year: 2024 }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findByCompany('company-1');

    expect(result).toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(2);
  });

  it('findByCompanies returns [] without querying when given an empty array', async () => {
    const result = await repo.findByCompanies([]);
    expect(result).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('upsert writes the row without stamping a workspace_id', async () => {
    await repo.upsert({
      company_id: 'company-1',
      fiscal_year: 2024,
      currency: 'USD',
    } as never);

    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'company-1', fiscal_year: 2024, currency: 'USD' }),
    );
  });

  it('bulkUpsertForCompany upserts every row for the given company', async () => {
    await repo.bulkUpsertForCompany('company-1', [
      { fiscal_year: 2023, currency: 'USD' } as never,
      { fiscal_year: 2024, currency: 'USD' } as never,
    ]);

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.values).toHaveBeenCalledTimes(2);
  });
});
