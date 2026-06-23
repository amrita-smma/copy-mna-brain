import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppSettingsRepository } from './appSettingsRepository';

// Chainable db mock. `get`/`getRow` await `.limit()`; `set` awaits
// `.onConflictDoUpdate()`.
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn(),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.leftJoin.mockReturnThis();
  mockDb.where.mockReturnThis();
  mockDb.insert.mockReturnThis();
  mockDb.values.mockReturnThis();
}

describe('AppSettingsRepository.get', () => {
  let repo: AppSettingsRepository;

  beforeEach(() => {
    resetDb();
    repo = new AppSettingsRepository(mockDb as never);
  });

  it('returns the stored JSON value for a key', async () => {
    mockDb.limit.mockResolvedValueOnce([{ value: { a: 1 } }]);
    await expect(repo.get('k')).resolves.toEqual({ a: 1 });
  });

  it('returns null when the key is unset', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.get('missing')).resolves.toBeNull();
  });
});

describe('AppSettingsRepository.getRow', () => {
  let repo: AppSettingsRepository;

  beforeEach(() => {
    resetDb();
    repo = new AppSettingsRepository(mockDb as never);
  });

  it('joins the editing user and shapes the audit metadata', async () => {
    mockDb.limit.mockResolvedValueOnce([
      {
        value: { a: 1 },
        updatedAt: '2026-06-23T10:00:00.000Z',
        updatedById: 'u1',
        updatedByName: 'Jane Doe',
        updatedByEmail: 'jane@sqe.co.id',
      },
    ]);

    const row = await repo.getRow('k');

    expect(mockDb.leftJoin).toHaveBeenCalledTimes(1);
    expect(row).toEqual({
      value: { a: 1 },
      updatedAt: '2026-06-23T10:00:00.000Z',
      updatedBy: { id: 'u1', name: 'Jane Doe', email: 'jane@sqe.co.id' },
    });
  });

  it('reports a null editor when updated_by is unset', async () => {
    mockDb.limit.mockResolvedValueOnce([
      {
        value: { a: 1 },
        updatedAt: '2026-06-23T10:00:00.000Z',
        updatedById: null,
        updatedByName: null,
        updatedByEmail: null,
      },
    ]);

    const row = await repo.getRow('k');
    expect(row?.updatedBy).toBeNull();
  });

  it('returns null when the key is unset', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.getRow('missing')).resolves.toBeNull();
  });
});

describe('AppSettingsRepository.set', () => {
  let repo: AppSettingsRepository;

  beforeEach(() => {
    resetDb();
    repo = new AppSettingsRepository(mockDb as never);
  });

  it('upserts the key with the given value and editing user', async () => {
    mockDb.onConflictDoUpdate.mockResolvedValueOnce(undefined);

    await repo.set('k', { hello: 'world' }, 'u1');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mockDb.values).toHaveBeenCalledWith({
      key: 'k',
      value: { hello: 'world' },
      updated_by: 'u1',
    });
    // Conflict on the primary key updates value + updated_by + updated_at.
    const arg = mockDb.onConflictDoUpdate.mock.calls[0][0];
    expect(arg.set).toHaveProperty('value', { hello: 'world' });
    expect(arg.set).toHaveProperty('updated_by', 'u1');
    expect(arg.set).toHaveProperty('updated_at');
  });

  it('defaults the editing user to null when omitted', async () => {
    mockDb.onConflictDoUpdate.mockResolvedValueOnce(undefined);

    await repo.set('k', { hello: 'world' });

    expect(mockDb.values).toHaveBeenCalledWith({
      key: 'k',
      value: { hello: 'world' },
      updated_by: null,
    });
  });
});
