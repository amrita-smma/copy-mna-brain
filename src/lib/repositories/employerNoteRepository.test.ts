import { describe, it, expect, vi, beforeEach } from 'vitest';
import { employerNoteRevisions, employerNotes } from '@/lib/db/schema';
import { EmployerNoteRepository } from './employerNoteRepository';

/** A chainable query stub; the terminal call of each test is set per case. */
function makeChain() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn().mockReturnThis(),
    for: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return chain;
}

function makeDb() {
  const tx = makeChain();
  const db = {
    ...makeChain(),
    tx,
    transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return db;
}

describe('EmployerNoteRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: EmployerNoteRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new EmployerNoteRepository(db as never);
  });

  describe('EmployerNoteRepository.findByEmployerId', () => {
    it('flattens the note with its author and last editor names', async () => {
      db.orderBy.mockResolvedValueOnce([
        { note: { id: 'n1', content: 'hi' }, author_name: 'Ann', updated_by_name: 'Bo' },
      ]);
      const result = await repo.findByEmployerId('e1', 'w1');
      expect(result).toEqual([
        { id: 'n1', content: 'hi', author_name: 'Ann', updated_by_name: 'Bo' },
      ]);
      expect(db.leftJoin).toHaveBeenCalledTimes(2);
    });
  });

  describe('EmployerNoteRepository.findById', () => {
    it('returns undefined when the note is in another workspace or deleted', async () => {
      db.limit.mockResolvedValueOnce([]);
      expect(await repo.findById('n1', 'other-workspace')).toBeUndefined();
    });
  });

  describe('EmployerNoteRepository.createWithRevision', () => {
    it('inserts the note and a create revision in one transaction', async () => {
      db.tx.returning.mockResolvedValueOnce([{ id: 'n1', content: 'hi' }]);
      const row = await repo.createWithRevision({
        employer_id: 'e1',
        workspace_id: 'w1',
        content: 'hi',
        author_user_id: 'u1',
      });
      expect(row).toEqual({ id: 'n1', content: 'hi' });
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(db.tx.insert).toHaveBeenNthCalledWith(1, employerNotes);
      expect(db.tx.insert).toHaveBeenNthCalledWith(2, employerNoteRevisions);
      expect(db.tx.values).toHaveBeenLastCalledWith({
        workspace_id: 'w1',
        note_id: 'n1',
        action: 'create',
        content_before: null,
        content_after: 'hi',
        changed_by: 'u1',
      });
    });
  });

  describe('EmployerNoteRepository.editWithRevision', () => {
    it('updates the content and records before and after', async () => {
      db.tx.for.mockResolvedValueOnce([{ id: 'n1', content: 'old' }]);
      db.tx.returning.mockResolvedValueOnce([{ id: 'n1', content: 'new' }]);
      const row = await repo.editWithRevision('n1', 'w1', 'new', 'u2');
      expect(row).toEqual({ id: 'n1', content: 'new' });
      expect(db.tx.for).toHaveBeenCalledWith('update');
      expect(db.tx.set).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'new', updated_by: 'u2' }),
      );
      expect(db.tx.values).toHaveBeenLastCalledWith({
        workspace_id: 'w1',
        note_id: 'n1',
        action: 'edit',
        content_before: 'old',
        content_after: 'new',
        changed_by: 'u2',
      });
    });

    it('writes nothing when the note is missing, deleted or in another workspace', async () => {
      db.tx.for.mockResolvedValueOnce([]);
      expect(await repo.editWithRevision('n1', 'w1', 'new', 'u2')).toBeUndefined();
      expect(db.tx.update).not.toHaveBeenCalled();
      expect(db.tx.insert).not.toHaveBeenCalled();
    });
  });

  describe('EmployerNoteRepository.softDeleteWithRevision', () => {
    it('stamps deleted_at/by instead of deleting, and keeps the last content in the revision', async () => {
      db.tx.for.mockResolvedValueOnce([{ id: 'n1', content: 'gone' }]);
      expect(await repo.softDeleteWithRevision('n1', 'w1', 'u3')).toBe(true);
      expect(db.tx.set).toHaveBeenCalledWith(
        expect.objectContaining({ deleted_by: 'u3', deleted_at: expect.any(String) }),
      );
      expect(db.tx.values).toHaveBeenLastCalledWith({
        workspace_id: 'w1',
        note_id: 'n1',
        action: 'delete',
        content_before: 'gone',
        content_after: null,
        changed_by: 'u3',
      });
    });

    it('returns false and writes nothing when there is no live note', async () => {
      db.tx.for.mockResolvedValueOnce([]);
      expect(await repo.softDeleteWithRevision('n1', 'w1', 'u3')).toBe(false);
      expect(db.tx.update).not.toHaveBeenCalled();
    });
  });

  describe('EmployerNoteRepository.listRevisions', () => {
    it('flattens each revision with the name of whoever made it', async () => {
      db.orderBy.mockResolvedValueOnce([
        { revision: { id: 'r1', action: 'create' }, changed_by_name: 'Ann' },
      ]);
      expect(await repo.listRevisions('n1', 'w1')).toEqual([
        { id: 'r1', action: 'create', changed_by_name: 'Ann' },
      ]);
    });
  });
});
