import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { WorkspaceCorrespondentRepository } from './workspaceCorrespondentRepository';

function makeDb() {
  return {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn(),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
}

describe('WorkspaceCorrespondentRepository.addMembership', () => {
  it('inserts a single membership row with its source and upgrades an existing row to manual on conflict', async () => {
    const db = makeDb();
    db.onConflictDoUpdate.mockResolvedValueOnce(undefined);
    const repo = new WorkspaceCorrespondentRepository(db as never);
    await repo.addMembership('w1', 'c1', 'manual');
    expect(db.values).toHaveBeenCalledWith({
      workspace_id: 'w1',
      correspondent_id: 'c1',
      source: 'manual',
    });
    expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
        set: expect.objectContaining({ source: expect.anything() }),
      }),
    );
  });
});

describe('WorkspaceCorrespondentRepository conflict resolution (manual > direct > ingest)', () => {
  it('the source upgrade CASE never downgrades manual or direct, and knows about direct', async () => {
    const db = makeDb();
    db.onConflictDoUpdate.mockResolvedValueOnce(undefined);
    const repo = new WorkspaceCorrespondentRepository(db as never);
    await repo.addMembership('w1', 'c1', 'direct');

    const setArg = db.onConflictDoUpdate.mock.calls[0]?.[0]?.set?.source;
    const { sql: text } = new PgDialect().sqlToQuery(setArg);
    expect(text).toContain("excluded.source = 'manual'");
    expect(text).toContain("excluded.source = 'direct'");
    expect(text).toContain("= 'manual'");
  });
});

describe('WorkspaceCorrespondentRepository.addMemberships', () => {
  it('returns without hitting the DB for an empty list', async () => {
    const db = makeDb();
    const repo = new WorkspaceCorrespondentRepository(db as never);
    await repo.addMemberships([]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('batch-inserts one row per pair, preserving each pair\'s own source, and upgrades to manual on conflict', async () => {
    const db = makeDb();
    db.onConflictDoUpdate.mockResolvedValueOnce(undefined);
    const repo = new WorkspaceCorrespondentRepository(db as never);
    await repo.addMemberships([
      { workspaceId: 'w1', correspondentId: 'c1', source: 'ingest' },
      { workspaceId: 'w1', correspondentId: 'c2', source: 'manual' },
      { workspaceId: 'w2', correspondentId: 'c1', source: 'ingest' },
    ]);
    expect(db.values).toHaveBeenCalledWith([
      { workspace_id: 'w1', correspondent_id: 'c1', source: 'ingest' },
      { workspace_id: 'w1', correspondent_id: 'c2', source: 'manual' },
      { workspace_id: 'w2', correspondent_id: 'c1', source: 'ingest' },
    ]);
    expect(db.onConflictDoUpdate).toHaveBeenCalled();
  });

  it('collapses duplicate (workspace, correspondent) pairs to one row, keeping the most durable source', async () => {
    const db = makeDb();
    db.onConflictDoUpdate.mockResolvedValueOnce(undefined);
    const repo = new WorkspaceCorrespondentRepository(db as never);
    await repo.addMemberships([
      { workspaceId: 'w1', correspondentId: 'c1', source: 'ingest' },
      { workspaceId: 'w1', correspondentId: 'c1', source: 'manual' },
      { workspaceId: 'w1', correspondentId: 'c1', source: 'ingest' },
      { workspaceId: 'w2', correspondentId: 'c1', source: 'ingest' },
    ]);
    expect(db.values).toHaveBeenCalledWith([
      { workspace_id: 'w1', correspondent_id: 'c1', source: 'manual' },
      { workspace_id: 'w2', correspondent_id: 'c1', source: 'ingest' },
    ]);
  });
});

describe('WorkspaceCorrespondentRepository.listVisibleCorrespondentIds', () => {
  it('returns correspondent ids visible to the workspace', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([
      { correspondent_id: 'c1' },
      { correspondent_id: 'c2' },
    ]);
    const repo = new WorkspaceCorrespondentRepository(db as never);
    expect(await repo.listVisibleCorrespondentIds('w1')).toEqual(['c1', 'c2']);
  });
});

describe('WorkspaceCorrespondentRepository.isVisible', () => {
  it('returns true when a membership row exists', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([{ correspondent_id: 'c1' }]);
    const repo = new WorkspaceCorrespondentRepository(db as never);
    expect(await repo.isVisible('w1', 'c1')).toBe(true);
  });

  it('returns false when no membership row exists', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([]);
    const repo = new WorkspaceCorrespondentRepository(db as never);
    expect(await repo.isVisible('w1', 'c1')).toBe(false);
  });
});
