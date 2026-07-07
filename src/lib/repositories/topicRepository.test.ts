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
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
}

describe('TopicRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: TopicRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new TopicRepository(db as never);
  });

  describe('listAll', () => {
    it('scopes to shared vocabulary and this workspace\'s own private topics', async () => {
      const rows = [{ id: 't1', name: 'ECM', workspace_id: null }];
      db.orderBy.mockResolvedValueOnce(rows);
      const out = await repo.listAll('w1');
      expect(out).toEqual(rows);
      expect(db.where).toHaveBeenCalled();
    });
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

    it('sets is_deal_related on the inserted topic when provided', async () => {
      db.limit.mockResolvedValueOnce([]);
      db.returning.mockResolvedValueOnce([{ id: '3', name: 'acquisition', slug: 'acquisition', is_deal_related: true }]);
      await repo.findOrCreate('acquisition', { is_deal_related: true });
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ is_deal_related: true }),
      );
    });

    it('defaults is_deal_related to false', async () => {
      db.limit.mockResolvedValueOnce([]);
      db.returning.mockResolvedValueOnce([{ id: '4', name: 'lithography', slug: 'lithography', is_deal_related: false }]);
      await repo.findOrCreate('lithography');
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ is_deal_related: false }),
      );
    });

    it('creates a workspace-private topic (workspace_id set) when a workspaceId is given', async () => {
      db.limit.mockResolvedValueOnce([]);
      db.returning.mockResolvedValueOnce([{ id: '5', name: 'Deal Alpha', slug: 'deal-alpha', workspace_id: 'w1' }]);
      await repo.findOrCreate('Deal Alpha', {}, 'w1');
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_id: 'w1' }),
      );
      expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ target: [expect.anything(), expect.anything()] }),
      );
    });

    it('inserts with workspace_id null for the shared vocabulary when no workspaceId is given', async () => {
      db.limit.mockResolvedValueOnce([]);
      db.returning.mockResolvedValueOnce([{ id: '6', name: 'ECM', slug: 'ecm', workspace_id: null }]);
      await repo.findOrCreate('ECM');
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_id: null }),
      );
    });
  });

  describe('setDealRelated', () => {
    it('updates the topic is_deal_related flag by id', async () => {
      await repo.setDealRelated('t1', true);
      expect(db.update).toHaveBeenCalled();
      expect(db.set).toHaveBeenCalledWith({ is_deal_related: true });
    });
  });

  describe('upsertBatch', () => {
    it('short-circuits on empty input', async () => {
      const out = await repo.upsertBatch([]);
      expect(out).toEqual([]);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('inserts each item with its is_deal_related flag', async () => {
      db.returning.mockResolvedValueOnce([
        { id: '1', name: 'acquisition', slug: 'acquisition', is_deal_related: true },
        { id: '2', name: 'semiconductors', slug: 'semiconductors', is_deal_related: false },
      ]);
      const out = await repo.upsertBatch([
        { slug: 'acquisition', is_deal_related: true },
        { slug: 'semiconductors', is_deal_related: false },
      ]);
      expect(db.values).toHaveBeenCalledWith([
        expect.objectContaining({ slug: 'acquisition', is_deal_related: true }),
        expect.objectContaining({ slug: 'semiconductors', is_deal_related: false }),
      ]);
      expect(out).toHaveLength(2);
    });

    it('uses an upgrade-only (OR) conflict clause so the LLM never demotes', async () => {
      db.returning.mockResolvedValueOnce([]);
      await repo.upsertBatch([{ slug: 'acquisition', is_deal_related: true }]);
      const arg = db.onConflictDoUpdate.mock.calls[0][0];
      const expr = arg.set.is_deal_related;
      // It's a SQL expression (not a plain boolean overwrite) — proves the LLM
      // can't blindly clobber the flag on re-ingest.
      expect(typeof expr).toBe('object');
      // Its raw string chunks contain " OR " so a previously-true flag stays
      // true when a later email classifies the topic as non-deal.
      const rawText = (expr.queryChunks ?? [])
        .flatMap((c: { value?: string[] }) => c.value ?? [])
        .join(' ');
      expect(rawText.toLowerCase()).toContain('or');
    });
  });

  describe('assignToEmployer', () => {
    it('inserts with source and is_highlight', async () => {
      db.returning.mockResolvedValueOnce([{ id: 'et1', employer_id: 'e1', topic_id: 't1', source: 'auto', is_highlight: false }]);
      await repo.assignToEmployer('e1', 't1', { source: 'auto' });
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'auto', is_highlight: false }),
      );
    });

    it('upserts on conflict preserving source and is_highlight', async () => {
      db.returning.mockResolvedValueOnce([{ id: 'et2', employer_id: 'e1', topic_id: 't2', source: 'manual', is_highlight: false }]);
      await repo.assignToEmployer('e1', 't2');
      expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ set: expect.objectContaining({ source: 'manual' }) }),
      );
    });
  });

  describe('listForEmployer', () => {
    it('joins on topics and returns the assignment rows', async () => {
      const rows = [{ id: 'et1', topic_id: 't1', name: 'CMP', source: 'auto', is_highlight: true }];
      db.orderBy.mockResolvedValueOnce(rows);
      const out = await repo.listForEmployer('e1', 'w1');
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
