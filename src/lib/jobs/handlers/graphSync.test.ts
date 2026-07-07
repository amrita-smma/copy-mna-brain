import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAllWorkspaces: vi.fn(),
  findAllCompanies: vi.fn(),
  syncFromDatabase: vi.fn(),
  createNeo4jDriver: vi.fn(() => ({})),
  companyRepoWorkspaceIds: [] as string[],
}));

vi.mock('@/lib/neo4j', () => ({ createNeo4jDriver: mocks.createNeo4jDriver }));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: class {
    constructor(_db: unknown, workspaceId: string) {
      mocks.companyRepoWorkspaceIds.push(workspaceId);
    }
    findAll = mocks.findAllCompanies;
  },
  WorkspaceRepository: class {
    findAll = mocks.findAllWorkspaces;
  },
}));

vi.mock('@/lib/repositories/companyRelationRepository', () => ({
  CompanyRelationRepository: class {},
}));

vi.mock('@/lib/services/companyGraphService', () => ({
  CompanyGraphService: class {
    syncFromDatabase = mocks.syncFromDatabase;
  },
}));

import { runGraphSync } from './graphSync';

afterEach(() => {
  vi.clearAllMocks();
  mocks.companyRepoWorkspaceIds = [];
});

describe('runGraphSync', () => {
  it('feeds the union of every workspace\'s companies into the reconciliation and returns its result', async () => {
    mocks.findAllWorkspaces.mockResolvedValue([{ id: 'ws1' }, { id: 'ws2' }]);
    mocks.findAllCompanies
      .mockResolvedValueOnce([{ id: 'c1' }])
      .mockResolvedValueOnce([{ id: 'c2' }]);
    mocks.syncFromDatabase.mockResolvedValue({ upserted: 2, deleted: 1 });

    const result = await runGraphSync({ db: {} as never });

    expect(mocks.companyRepoWorkspaceIds).toEqual(['ws1', 'ws2']);
    expect(mocks.syncFromDatabase).toHaveBeenCalledWith([{ id: 'c1' }, { id: 'c2' }]);
    expect(result).toEqual({ upserted: 2, deleted: 1 });
  });

  it('does not treat one workspace\'s companies as stale relative to another', async () => {
    // Regression guard: syncFromDatabase must be called once with the full
    // union, never once per workspace — calling it per-workspace would prune
    // every other workspace's nodes as "not in this list".
    mocks.findAllWorkspaces.mockResolvedValue([{ id: 'ws1' }, { id: 'ws2' }]);
    mocks.findAllCompanies
      .mockResolvedValueOnce([{ id: 'c1' }])
      .mockResolvedValueOnce([{ id: 'c2' }]);
    mocks.syncFromDatabase.mockResolvedValue({ upserted: 2, deleted: 0 });

    await runGraphSync({ db: {} as never });

    expect(mocks.syncFromDatabase).toHaveBeenCalledTimes(1);
  });
});
