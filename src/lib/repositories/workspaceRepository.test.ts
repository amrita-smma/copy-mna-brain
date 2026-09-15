import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceRepository } from './workspaceRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

/** A soft-deleted row, for the archive-aware lookups. */
const ARCHIVED = { id: 'w2', name: 'Old', slug: 'old', deleted_at: '2026-09-15T00:00:00.000Z' };

describe('WorkspaceRepository', () => {
  let mockDb: MockDb;
  let repo: WorkspaceRepository;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    repo = new WorkspaceRepository(mockDb as never);
  });

  it('findAll filters out soft-deleted workspaces', async () => {
    const rows = [{ id: 'w1', name: 'MNA', slug: 'mna', deleted_at: null }];
    mockDb.where.mockResolvedValueOnce(rows);

    const result = await repo.findAll();

    expect(result).toEqual(rows);
    // The `deleted_at IS NULL` predicate — without it every listing (picker,
    // switcher, cron sweeps) would keep showing archived workspaces.
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it('findAllIncludingDeleted returns every row without a filter', async () => {
    const rows = [{ id: 'w1', name: 'MNA', slug: 'mna', deleted_at: null }, ARCHIVED];
    mockDb.from.mockResolvedValueOnce(rows);

    const result = await repo.findAllIncludingDeleted();

    expect(result).toEqual(rows);
    expect(mockDb.where).not.toHaveBeenCalled();
  });

  it('findActiveById filters on deleted_at and returns nothing for an archived row', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await repo.findActiveById('w2');

    expect(result).toBeUndefined();
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it('findBySlug returns a soft-deleted row too, so callers can tell archived from unknown', async () => {
    mockDb.limit.mockResolvedValueOnce([ARCHIVED]);

    const result = await repo.findBySlug('old');

    expect(result).toEqual(ARCHIVED);
  });

  it('softDelete stamps deleted_at and returns the archived row', async () => {
    mockDb.returning.mockResolvedValueOnce([ARCHIVED]);

    const result = await repo.softDelete('w2');

    expect(result).toEqual(ARCHIVED);
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.anything(), updated_at: expect.anything() }),
    );
  });

  it('softDelete returns undefined when the row is already archived', async () => {
    mockDb.returning.mockResolvedValueOnce([]);

    const result = await repo.softDelete('w2');

    expect(result).toBeUndefined();
  });

  it('restore clears deleted_at', async () => {
    const restored = { ...ARCHIVED, deleted_at: null };
    mockDb.returning.mockResolvedValueOnce([restored]);

    const result = await repo.restore('w2');

    expect(result).toEqual(restored);
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: null, updated_at: expect.anything() }),
    );
  });

  it('findById returns the matching row, archived or not', async () => {
    const row = { id: 'w1', name: 'MNA', slug: 'mna' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findById('w1');

    expect(result).toEqual(row);
  });

  it('insert returns the inserted row', async () => {
    const row = { id: 'w1', name: 'MNA', slug: 'mna' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ name: 'MNA', slug: 'mna' } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ name: 'MNA', slug: 'mna' });
  });

  it('update returns the updated row', async () => {
    const row = { id: 'w1', name: 'Renamed', slug: 'mna' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.update('w1', { name: 'Renamed' });

    expect(result).toEqual(row);
    expect(mockDb.set).toHaveBeenCalledWith({ name: 'Renamed' });
  });
});
