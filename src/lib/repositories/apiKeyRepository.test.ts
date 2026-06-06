import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyRepository } from './apiKeyRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

describe('ApiKeyRepository', () => {
  let mockDb: MockDb;
  let repo: ApiKeyRepository;

  beforeEach(() => {
    mockDb = {
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
    };
    repo = new ApiKeyRepository(mockDb as never);
  });

  it('create returns the inserted row', async () => {
    const row = { id: 'k1', name: 'partner', key_prefix: 'abcd1234' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.create({
      name: 'partner',
      key_prefix: 'abcd1234',
      key_hash: 'scrypt$x$y',
      scopes: ['chat:write'],
    } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({
      name: 'partner',
      key_prefix: 'abcd1234',
      key_hash: 'scrypt$x$y',
      scopes: ['chat:write'],
    });
  });

  it('getById returns the row when found', async () => {
    const row = { id: 'k1' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.getById('k1');

    expect(result).toEqual(row);
  });

  it('getById returns null when not found', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await repo.getById('missing');

    expect(result).toBeNull();
  });

  it('list returns rows ordered by created_at desc', async () => {
    const rows = [{ id: 'k2' }, { id: 'k1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.list();

    expect(result).toEqual(rows);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('update returns the updated row', async () => {
    const row = { id: 'k1', name: 'renamed' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.update('k1', { name: 'renamed' });

    expect(result).toEqual(row);
    expect(mockDb.set).toHaveBeenCalledWith({ name: 'renamed' });
  });

  it('update returns null when no row matches', async () => {
    mockDb.returning.mockResolvedValueOnce([]);

    const result = await repo.update('missing', { name: 'x' });

    expect(result).toBeNull();
  });

  it('findActiveByPrefix returns matching non-revoked rows', async () => {
    const rows = [{ id: 'k1', key_prefix: 'abcd1234' }];
    mockDb.where.mockResolvedValueOnce(rows);

    const result = await repo.findActiveByPrefix('abcd1234');

    expect(result).toEqual(rows);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('touchLastUsed issues an update', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.touchLastUsed('k1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledTimes(1);
  });

  it('revoke sets revoked_at and returns the row', async () => {
    const row = { id: 'k1', revoked_at: '2026-06-06T00:00:00Z' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.revoke('k1');

    expect(result).toEqual(row);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledTimes(1);
  });
});
