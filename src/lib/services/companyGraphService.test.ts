import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyGraphService, type GraphSyncCompany } from './companyGraphService';
import type { CompanyRelationRepository } from '@/lib/repositories/companyRelationRepository';
import type { JobDispatcher } from './jobDispatcher';

// The handler is imported lazily by dispatchSync(); stub it so we neither load
// the real Neo4j driver nor run reconciliation here.
vi.mock('@/lib/jobs/handlers/graphSync', () => ({
  GRAPH_SYNC_TIMEOUT_SECONDS: 480,
  runGraphSync: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

function makeRelationRepo() {
  return {
    upsertCompanies: vi.fn().mockResolvedValue(undefined),
    getAllCompanyIds: vi.fn().mockResolvedValue([]),
    deleteCompaniesByIds: vi.fn().mockResolvedValue(undefined),
    getGraphData: vi.fn(),
  } as unknown as CompanyRelationRepository & {
    upsertCompanies: ReturnType<typeof vi.fn>;
    getAllCompanyIds: ReturnType<typeof vi.fn>;
    deleteCompaniesByIds: ReturnType<typeof vi.fn>;
  };
}

function company(overrides: Partial<GraphSyncCompany> = {}): GraphSyncCompany {
  return {
    id: 'c1',
    target: 'Acme Corp',
    project_name: null,
    segment: 'technology',
    geography: 'Indonesia',
    ownership: 'public',
    ...overrides,
  };
}

describe('CompanyGraphService.syncFromDatabase', () => {
  it('upserts a mapped node for every company', async () => {
    const repo = makeRelationRepo();
    const service = new CompanyGraphService(repo);

    await service.syncFromDatabase([
      company({ id: 'c1', target: 'Acme Corp' }),
      company({ id: 'c2', target: 'LogistiKa' }),
    ]);

    expect(repo.upsertCompanies).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'c1', name: 'Acme Corp' }),
      expect.objectContaining({ id: 'c2', name: 'LogistiKa' }),
    ]);
  });

  it('maps pipeline_stage and status onto the graph node', async () => {
    const repo = makeRelationRepo();
    const service = new CompanyGraphService(repo);

    await service.syncFromDatabase([
      company({ id: 'c1', pipeline_stage: 'L2', status: 'dropped' }),
    ]);

    expect(repo.upsertCompanies).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'c1', pipelineStage: 'L2', status: 'dropped' }),
    ]);
  });

  it('prunes graph nodes whose company row no longer exists', async () => {
    const repo = makeRelationRepo();
    // Graph has c1, c2, c3; Postgres only has c1, c2 → c3 is stale.
    repo.getAllCompanyIds.mockResolvedValue(['c1', 'c2', 'c3']);
    const service = new CompanyGraphService(repo);

    const result = await service.syncFromDatabase([
      company({ id: 'c1' }),
      company({ id: 'c2' }),
    ]);

    expect(repo.deleteCompaniesByIds).toHaveBeenCalledWith(['c3']);
    expect(result).toEqual({ upserted: 2, deleted: 1 });
  });

  it('reports zero deletions when the graph is already a subset of Postgres', async () => {
    const repo = makeRelationRepo();
    repo.getAllCompanyIds.mockResolvedValue(['c1']);
    const service = new CompanyGraphService(repo);

    const result = await service.syncFromDatabase([company({ id: 'c1' }), company({ id: 'c2' })]);

    expect(repo.deleteCompaniesByIds).toHaveBeenCalledWith([]);
    expect(result).toEqual({ upserted: 2, deleted: 0 });
  });
});

describe('CompanyGraphService.dispatchSync', () => {
  it('dispatches a graph_sync job and returns the job id', async () => {
    const repo = makeRelationRepo();
    const dispatch = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const jobDispatcher = { dispatch } as unknown as JobDispatcher;
    const service = new CompanyGraphService(repo, jobDispatcher);

    const result = await service.dispatchSync();

    expect(result).toEqual({ jobId: 'job-1' });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'graph_sync', timeoutSeconds: 480, payload: {} }),
    );
  });

  it('throws when no JobDispatcher is wired', async () => {
    const repo = makeRelationRepo();
    const service = new CompanyGraphService(repo);

    await expect(service.dispatchSync()).rejects.toThrow('requires a JobDispatcher');
  });
});
