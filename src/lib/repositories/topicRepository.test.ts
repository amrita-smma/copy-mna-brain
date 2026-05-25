import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TopicRepository } from './topicRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('TopicRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: TopicRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new TopicRepository(db as never);
  });

  describe('findOrCreate', () => {
    it('returns the existing topic instead of double-inserting', async () => {
      db.limit.mockResolvedValueOnce([{ id: '1', name: 'CMP' }]);
      const out = await repo.findOrCreate('CMP');
      expect(out).toEqual({ id: '1', name: 'CMP' });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('slugifies the name when inserting a new topic', async () => {
      db.limit.mockResolvedValueOnce([]);
      db.returning.mockResolvedValueOnce([{ id: '2', name: 'CMP slurry', slug: 'cmp-slurry' }]);
      const out = await repo.findOrCreate('CMP slurry');
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'cmp-slurry' }),
      );
      expect(out.slug).toBe('cmp-slurry');
    });
  });

  describe('listForEmployer', () => {
    it('joins on topics and returns the assignment rows', async () => {
      const rows = [{ id: 'et1', topic_id: 't1', name: 'CMP', source: 'auto', is_highlight: true }];
      db.orderBy.mockResolvedValueOnce(rows);
      const out = await repo.listForEmployer('e1');
      expect(out).toEqual(rows);
      expect(db.innerJoin).toHaveBeenCalled();
    });
  });

  describe('findByIds', () => {
    it('short-circuits on empty input', async () => {
      const out = await repo.findByIds([]);
      expect(out).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });
  });
});
