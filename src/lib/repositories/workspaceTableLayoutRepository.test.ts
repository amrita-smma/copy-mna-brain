import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceTableLayoutRepository } from './workspaceTableLayoutRepository';

// Chainable db mock. `findAll` awaits `.where()`; `findByTableId` awaits
// `.limit()`; `upsert` awaits `.onConflictDoUpdate()`; `delete` awaits
// `.where()` off the delete chain.
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  returning: vi.fn(),
  delete: vi.fn().mockReturnThis(),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.where.mockReturnThis();
  mockDb.insert.mockReturnThis();
  mockDb.values.mockReturnThis();
  mockDb.onConflictDoUpdate.mockReturnThis();
  mockDb.delete.mockReturnThis();
}

const LAYOUT = { order: ['a', 'b'], hidden: ['b'], groups: [] };

describe('WorkspaceTableLayoutRepository.findAll', () => {
  let repo: WorkspaceTableLayoutRepository;

  beforeEach(() => {
    resetDb();
    repo = new WorkspaceTableLayoutRepository(mockDb as never, 'ws-1');
  });

  it('returns every stored layout for the workspace', async () => {
    mockDb.where.mockResolvedValueOnce([
      {
        tableId: 'master-data',
        layout: LAYOUT,
        updatedAt: '2026-08-01T00:00:00.000Z',
        updatedBy: 'u1',
      },
      { tableId: 'smart-files', layout: LAYOUT, updatedAt: null, updatedBy: null },
    ]);

    const rows = await repo.findAll();

    expect(rows).toEqual([
      {
        tableId: 'master-data',
        layout: LAYOUT,
        updatedAt: '2026-08-01T00:00:00.000Z',
        updatedBy: 'u1',
      },
      { tableId: 'smart-files', layout: LAYOUT, updatedAt: null, updatedBy: null },
    ]);
  });

  it('returns [] when the workspace has never saved a layout', async () => {
    mockDb.where.mockResolvedValueOnce([]);
    expect(await repo.findAll()).toEqual([]);
  });
});

describe('WorkspaceTableLayoutRepository.findByTableId', () => {
  let repo: WorkspaceTableLayoutRepository;

  beforeEach(() => {
    resetDb();
    repo = new WorkspaceTableLayoutRepository(mockDb as never, 'ws-1');
  });

  it('returns the row for the requested table', async () => {
    mockDb.limit.mockResolvedValueOnce([
      {
        tableId: 'pipeline-inbound:active',
        layout: LAYOUT,
        updatedAt: '2026-08-01T00:00:00.000Z',
        updatedBy: 'u1',
      },
    ]);

    expect(await repo.findByTableId('pipeline-inbound:active')).toEqual({
      tableId: 'pipeline-inbound:active',
      layout: LAYOUT,
      updatedAt: '2026-08-01T00:00:00.000Z',
      updatedBy: 'u1',
    });
  });

  it('returns null when the table has no stored layout', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    expect(await repo.findByTableId('unknown-table')).toBeNull();
  });
});

describe('WorkspaceTableLayoutRepository.upsert', () => {
  let repo: WorkspaceTableLayoutRepository;

  beforeEach(() => {
    resetDb();
    repo = new WorkspaceTableLayoutRepository(mockDb as never, 'ws-1');
  });

  it("writes the row against the repository's own workspace", async () => {
    mockDb.returning.mockResolvedValueOnce([{ updatedAt: '2026-08-11T00:00:00.000Z' }]);

    const updatedAt = await repo.upsert('master-data', LAYOUT, 'u1');

    expect(mockDb.values).toHaveBeenCalledWith({
      workspace_id: 'ws-1',
      table_id: 'master-data',
      layout: LAYOUT,
      updated_by: 'u1',
    });
    expect(mockDb.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(updatedAt).toBe('2026-08-11T00:00:00.000Z');
  });

  it('stores a null updated_by when no user is supplied', async () => {
    mockDb.returning.mockResolvedValueOnce([{ updatedAt: null }]);

    await repo.upsert('master-data', LAYOUT);

    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ updated_by: null }),
    );
  });

  it('reports a null timestamp when the write returns no row', async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    expect(await repo.upsert('master-data', LAYOUT)).toBeNull();
  });
});

describe('WorkspaceTableLayoutRepository.delete', () => {
  it('issues a delete scoped to the workspace and table', async () => {
    resetDb();
    mockDb.where.mockResolvedValueOnce(undefined);
    const repo = new WorkspaceTableLayoutRepository(mockDb as never, 'ws-1');

    await repo.delete('master-data');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });
});
