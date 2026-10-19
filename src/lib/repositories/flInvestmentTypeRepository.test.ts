import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlInvestmentTypeRepository } from './flInvestmentTypeRepository';

function createMockDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
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

describe('FlInvestmentTypeRepository', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let repo: FlInvestmentTypeRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlInvestmentTypeRepository(mockDb as never);
  });

  it('findByWorkspaceId returns the ordered list', async () => {
    const rows = [{ id: 't1', name: 'Venture Capital', sort_order: 0 }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    await expect(repo.findByWorkspaceId('ws-1')).resolves.toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('findById returns undefined when nothing matches', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.findById('ws-1', 'missing')).resolves.toBeUndefined();
  });

  it('create inserts and returns the row', async () => {
    const row = { id: 't1', workspace_id: 'ws-1', name: 'Others', sort_order: 4 };
    mockDb.returning.mockResolvedValueOnce([row]);

    await expect(
      repo.create({ workspace_id: 'ws-1', name: 'Others', sort_order: 4 }),
    ).resolves.toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ workspace_id: 'ws-1', name: 'Others', sort_order: 4 });
  });

  it('update sets the fields plus updated_at and returns the row', async () => {
    const row = { id: 't1', name: 'Renamed' };
    mockDb.returning.mockResolvedValueOnce([row]);

    await expect(repo.update('ws-1', 't1', { name: 'Renamed' })).resolves.toEqual(row);
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Renamed', updated_at: expect.anything() }),
    );
  });

  it('delete uses the supplied executor', async () => {
    const exec = createMockDb();
    await repo.delete('ws-1', 't1', exec as never);
    expect(exec.delete).toHaveBeenCalledTimes(1);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});
