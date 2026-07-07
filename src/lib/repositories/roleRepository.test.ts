import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoleRepository } from './roleRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
}

describe('RoleRepository', () => {
  let mockDb: MockDb;
  let repo: RoleRepository;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    };
    repo = new RoleRepository(mockDb as never);
  });

  it('findAll returns every role', async () => {
    const rows = [{ id: 'r1', name: 'admin' }];
    mockDb.from.mockResolvedValueOnce(rows);

    const result = await repo.findAll();

    expect(result).toEqual(rows);
  });

  it('findByName returns the matching row', async () => {
    const row = { id: 'r1', name: 'editor' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findByName('editor');

    expect(result).toEqual(row);
  });

  it('insert returns the inserted row', async () => {
    const row = { id: 'r1', name: 'viewer' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ name: 'viewer' } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ name: 'viewer' });
  });
});
