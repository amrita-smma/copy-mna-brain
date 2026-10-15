import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserTaskRepository } from './userTaskRepository';

function makeDb() {
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  return db;
}

describe('UserTaskRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: UserTaskRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new UserTaskRepository(db as never, 'ws-1');
  });

  describe('UserTaskRepository.listForUser', () => {
    it('returns open tasks before completed ones and caps the completed slice', async () => {
      // Open rows come back newest-first and are returned oldest-first.
      const open = [{ id: 'a2', completed_at: null }, { id: 'a1', completed_at: null }];
      const done = [{ id: 'b', completed_at: '2026-10-14T00:00:00Z' }];
      db.limit.mockResolvedValueOnce(open).mockResolvedValueOnce(done);

      const rows = await repo.listForUser('u1', { openLimit: 500, completedLimit: 20 });

      expect(rows.map((r) => r.id)).toEqual(['a1', 'a2', 'b']);
      expect(db.limit).toHaveBeenNthCalledWith(1, 500);
      expect(db.limit).toHaveBeenNthCalledWith(2, 20);
    });
  });

  describe('UserTaskRepository.create', () => {
    it('inserts the task under the repository workspace and the given user', async () => {
      const row = { id: 't1', title: 'Call banker' };
      db.returning.mockResolvedValueOnce([row]);

      const result = await repo.create('u1', { title: 'Call banker', remind_at: null });

      expect(result).toEqual(row);
      expect(db.values).toHaveBeenCalledWith({
        workspace_id: 'ws-1',
        user_id: 'u1',
        title: 'Call banker',
        remind_at: null,
      });
    });
  });

  describe('UserTaskRepository.update', () => {
    it('returns the updated row', async () => {
      db.returning.mockResolvedValueOnce([{ id: 't1', title: 'New' }]);

      const result = await repo.update('t1', 'u1', { title: 'New' });

      expect(result).toEqual({ id: 't1', title: 'New' });
      expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ title: 'New' }));
    });

    it('returns null when the task does not belong to the user', async () => {
      db.returning.mockResolvedValueOnce([]);

      await expect(repo.update('t1', 'other', { title: 'x' })).resolves.toBeNull();
    });
  });

  describe('UserTaskRepository.delete', () => {
    it('reports whether a row was removed', async () => {
      db.returning.mockResolvedValueOnce([{ id: 't1' }]).mockResolvedValueOnce([]);

      await expect(repo.delete('t1', 'u1')).resolves.toBe(true);
      await expect(repo.delete('t1', 'u1')).resolves.toBe(false);
    });
  });

  describe('UserTaskRepository.claimDueReminders', () => {
    it('stamps the due slice in one update and returns the claimed rows', async () => {
      // The subquery chain ends at limit and is passed into the update's where.
      db.limit.mockReturnValueOnce(db);
      db.returning.mockResolvedValueOnce([{ id: 't1' }]);

      const rows = await repo.claimDueReminders('2026-10-15T00:00:00.000Z', 200);

      expect(rows).toEqual([{ id: 't1' }]);
      expect(db.limit).toHaveBeenCalledWith(200);
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(db.set).toHaveBeenCalledWith({ reminder_sent_at: '2026-10-15T00:00:00.000Z' });
    });
  });

  describe('UserTaskRepository.releaseReminders', () => {
    it('returns without hitting the DB when the id list is empty', async () => {
      await repo.releaseReminders([], '2026-10-15T00:00:00.000Z');

      expect(db.update).not.toHaveBeenCalled();
    });

    it('clears the stamp for every id in a single update', async () => {
      db.where.mockResolvedValueOnce(undefined);

      await repo.releaseReminders(['t1', 't2'], '2026-10-15T00:00:00.000Z');

      expect(db.update).toHaveBeenCalledTimes(1);
      expect(db.set).toHaveBeenCalledWith({ reminder_sent_at: null });
    });
  });
});
