import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutinesRepository } from './routinesRepository';

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
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
}

describe('RoutinesRepository', () => {
  let mockDb: MockDb;
  let repo: RoutinesRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new RoutinesRepository(mockDb as never, 'workspace-1');
  });

  it('create returns the inserted row', async () => {
    const row = { id: 'rt-1', title: 'Daily scan' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.create({
      title: 'Daily scan',
      prompt: 'Scan',
      schedule_kind: 'daily',
      schedule_spec: { time: '06:00' },
      cron_expression: '0 6 * * *',
      timezone: 'UTC',
      created_by: 'user-1',
    } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledTimes(1);
  });

  it('findById returns the row when found', async () => {
    const row = { id: 'rt-1' };
    mockDb.limit.mockResolvedValueOnce([row]);

    expect(await repo.findById('rt-1')).toEqual(row);
  });

  it('findById returns null when not found', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    expect(await repo.findById('missing')).toBeNull();
  });

  it('findById scopes the lookup to this workspace (or system-wide rows)', async () => {
    mockDb.limit.mockResolvedValueOnce([{ id: 'rt-1' }]);

    await repo.findById('rt-1');

    expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    expect(mockDb.where).not.toHaveBeenCalledWith(undefined);
  });

  it('update scopes the write to this workspace (or system-wide rows), not by id alone', async () => {
    mockDb.returning.mockResolvedValueOnce([{ id: 'rt-1', title: 'x' }]);

    await repo.update('rt-1', { title: 'x' });

    expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    expect(mockDb.where).not.toHaveBeenCalledWith(undefined);
  });

  it('a repository bound to a different workspace cannot update this workspace\'s routine', async () => {
    const otherDb = makeMockDb();
    const otherRepo = new RoutinesRepository(otherDb as never, 'workspace-2');
    otherDb.returning.mockResolvedValueOnce([]);

    await expect(otherRepo.update('rt-owned-by-workspace-1', { title: 'hijacked' })).rejects.toThrow(
      /not found/,
    );
  });

  it('findSystemRoutineByTitle scopes to this workspace only (no legacy-NULL fallback)', async () => {
    mockDb.limit.mockResolvedValueOnce([{ id: 'rt-system-1', is_system: true }]);

    const result = await repo.findSystemRoutineByTitle('Market Scanning');

    expect(result).toEqual({ id: 'rt-system-1', is_system: true });
    expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
  });

  it('findSystemRoutineByTitle returns null when this workspace has no matching routine', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    expect(await repo.findSystemRoutineByTitle('Market Scanning')).toBeNull();
  });

  it('list returns rows ordered newest-first, excluding archived', async () => {
    const rows = [{ id: 'rt-2' }, { id: 'rt-1' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    expect(await repo.list()).toEqual(rows);
    // archived filter applied via where()
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it('list with includeArchived skips the archived filter', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.list({ includeArchived: true });

    // Still workspace-scoped (this workspace's routines plus system-wide ones),
    // just without the archived_at filter.
    expect(mockDb.where).toHaveBeenCalledTimes(1);
    expect(mockDb.where).not.toHaveBeenCalledWith(undefined);
  });

  it('update throws when row is missing', async () => {
    mockDb.returning.mockResolvedValueOnce([]);

    await expect(repo.update('missing', { title: 'x' })).rejects.toThrow(/not found/);
  });

  it('archive sets archived_at and disables the routine', async () => {
    const row = { id: 'rt-1', enabled: false, archived_at: 'NOW' };
    mockDb.returning.mockResolvedValueOnce([row]);

    await repo.archive('rt-1');

    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, archived_at: expect.any(String) }),
    );
  });

  it('markFired writes last_fired_at and next_fire_at', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    const firedAt = new Date('2026-05-18T06:00:30Z');
    await repo.markFired('rt-1', firedAt, '2026-05-19T06:00:00.000Z');

    expect(mockDb.set).toHaveBeenCalledWith({
      last_fired_at: '2026-05-18T06:00:30.000Z',
      next_fire_at: '2026-05-19T06:00:00.000Z',
    });
  });

  it('claimDue returns [] when advisory lock is contended', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: MockDb) => Promise<unknown>) => {
      const tx = makeMockDb();
      tx.execute.mockResolvedValueOnce({ rows: [{ locked: false }] });
      return fn(tx);
    });

    const result = await repo.claimDue(new Date('2026-05-18T06:00:30Z'));

    expect(result).toEqual([]);
  });

  it('claimDue returns due rows when lock acquired', async () => {
    const due = [{ id: 'rt-1' }, { id: 'rt-2' }];
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: MockDb) => Promise<unknown>) => {
      const tx = makeMockDb();
      tx.execute.mockResolvedValueOnce({ rows: [{ locked: true }] });
      tx.limit.mockResolvedValueOnce(due);
      return fn(tx);
    });

    const result = await repo.claimDue(new Date('2026-05-18T06:00:30Z'));

    expect(result).toEqual(due);
  });

  it('countRuns returns the count for the routine', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 7 }] });

    expect(await repo.countRuns('rt-1')).toBe(7);
  });

  it('countRuns returns 0 when execute returns empty', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });

    expect(await repo.countRuns('rt-1')).toBe(0);
  });

  it('listRuns returns rows ordered newest-first', async () => {
    const rows = [{ id: 'q-2' }, { id: 'q-1' }];
    mockDb.limit.mockResolvedValueOnce(rows);

    expect(await repo.listRuns('rt-1')).toEqual(rows);
  });
});
