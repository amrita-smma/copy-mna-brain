import { describe, expect, it, vi, beforeEach } from 'vitest';

const createNeo4jDriverMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/neo4j', () => ({ createNeo4jDriver: createNeo4jDriverMock }));

import { createContainer } from './container';
import { InsightTemplateRepository } from '@/lib/repositories/insightTemplateRepository';
import { InsightRepository } from '@/lib/repositories/insightRepository';
import { CRMService } from './crmService';
import { FundUpdateApplyService } from './fundUpdateApplyService';
import { FundCatalogCheckService } from './fundCatalogCheckService';
import { WorkspaceRepository } from '@/lib/repositories';
import { JobDispatcher } from './jobDispatcher';
import { JobService } from './jobService';

describe('createContainer', () => {
  beforeEach(() => {
    createNeo4jDriverMock.mockClear();
  });

  it('gives the insight service the workspace template repository for source templates', () => {
    const { insightService } = createContainer({} as never, 'ws-1');
    const templateRepo = (insightService as unknown as { templateRepo: unknown }).templateRepo;

    expect(templateRepo).toBeInstanceOf(InsightTemplateRepository);
    expect((templateRepo as unknown as { workspaceId: string }).workspaceId).toBe('ws-1');
  });

  it('gives the template service the insight repository and workspace for usage counts', () => {
    const { insightTemplateService } = createContainer({} as never, 'ws-1');
    const svc = insightTemplateService as unknown as { insightRepo: unknown; workspaceId: string };

    expect(svc.insightRepo).toBeInstanceOf(InsightRepository);
    expect(svc.workspaceId).toBe('ws-1');
  });

  it('constructs services lazily: building the container touches no dependency', () => {
    // The Neo4j driver is a construction-time dependency of the company
    // repository, which almost every company-adjacent service reaches. Under
    // the eager container it was created on every createContainer call; now
    // it must not exist until a service that needs it is first accessed.
    const container = createContainer({} as never, 'ws-1');
    expect(createNeo4jDriverMock).not.toHaveBeenCalled();

    void container.jobService; // a graph-less service does not wake the driver
    expect(createNeo4jDriverMock).not.toHaveBeenCalled();

    void container.companyGraphService;
    expect(createNeo4jDriverMock).toHaveBeenCalledTimes(1);
  });

  it('memoizes each service: repeated access returns the same instance', () => {
    const container = createContainer({} as never, 'ws-1');

    expect(container.jobService).toBeInstanceOf(JobService);
    expect(container.jobService).toBe(container.jobService);
    expect(container.companyService).toBe(container.companyService);
    // Shared dependencies are memoized across services too: the company repo
    // inside companyService is the same object the relationship service got.
    const repoA = (container.companyService as unknown as { companyRepo: unknown }).companyRepo;
    const repoB = (container.companyRelationshipService as unknown as { companyRepo: unknown })
      .companyRepo;
    expect(repoA).toBeDefined();
    expect(repoA).toBe(repoB);
    expect(createNeo4jDriverMock).toHaveBeenCalledTimes(1);
  });

  it('exposes every Container key as an enumerable own property', () => {
    // Routes destructure the container, and some callers spread or iterate
    // it. Getter-based laziness must not change the observable key set.
    const keys = Object.keys(createContainer({} as never, 'ws-1'));
    expect(keys).toContain('companyService');
    expect(keys).toContain('fileService');
    expect(keys).toContain('userMemoryService');
    expect(keys.length).toBeGreaterThanOrEqual(60);
  });

  it('hands out a fully wired fileService with its setter-injected collaborators', () => {
    const { fileService } = createContainer({} as never, 'ws-1');
    const internals = fileService as unknown as {
      workspaceRepo: unknown;
      crmService: unknown;
      jobDispatcher: unknown;
      fundUpdateApplyService: unknown;
      fundCatalogCheckService: unknown;
    };

    expect(internals.workspaceRepo).toBeInstanceOf(WorkspaceRepository);
    expect(internals.crmService).toBeInstanceOf(CRMService);
    expect(internals.jobDispatcher).toBeInstanceOf(JobDispatcher);
    expect(internals.fundUpdateApplyService).toBeInstanceOf(FundUpdateApplyService);
    expect(internals.fundCatalogCheckService).toBeInstanceOf(FundCatalogCheckService);
  });

  it('late-wires the deal-link service into Smart Files', () => {
    const { dealContactService, fileService } = createContainer({} as never, 'ws-1');

    expect((fileService as unknown as { dealContactService: unknown }).dealContactService).toBe(
      dealContactService,
    );
  });
});
