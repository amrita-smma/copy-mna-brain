import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  agentInvoke,
  extractMessageText,
  findTargetNames,
  insertCompany,
  bulkUpsertForCompany,
  findByIds,
  updateMany,
} = vi.hoisted(() => ({
  agentInvoke: vi.fn(),
  extractMessageText: vi.fn(),
  findTargetNames: vi.fn(),
  insertCompany: vi.fn(),
  bulkUpsertForCompany: vi.fn(),
  findByIds: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('@/lib/agents/analysis', () => ({
  getStatelessAgentGraph: vi.fn(async () => ({ invoke: agentInvoke })),
  extractMessageText,
  HumanMessage: class {
    constructor(public content: string) {}
  },
}));

vi.mock('@/lib/agents/analysis/tools', () => ({
  companiesSchema: [],
}));

vi.mock('@/lib/repositories', () => {
  class MockCompanyRepository {
    findTargetNames = findTargetNames;
    insert = insertCompany;
  }
  class MockCompanyFinancialRepository {
    bulkUpsertForCompany = bulkUpsertForCompany;
  }
  class MockInvestmentThesisRepository {
    findByIds = findByIds;
    updateMany = updateMany;
  }
  return {
    CompanyRepository: MockCompanyRepository,
    CompanyFinancialRepository: MockCompanyFinancialRepository,
    InvestmentThesisRepository: MockInvestmentThesisRepository,
  };
});

vi.mock('@/lib/posthog-server', () => ({ getPostHogClient: () => null }));

import { runMarketScreening } from './marketScreening';

const NOW = new Date('2026-07-03T10:00:00.000Z');

function mockAgentResponse(text: string) {
  agentInvoke.mockResolvedValueOnce({ messages: [{ _getType: () => 'ai' }] });
  extractMessageText.mockReturnValueOnce(text);
}

function foundCompanies(...names: string[]) {
  return JSON.stringify({ companies: names.map((n) => ({ company_name: n })) });
}

describe('runMarketScreening', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    agentInvoke.mockReset();
    extractMessageText.mockReset();
    findTargetNames.mockReset().mockResolvedValue([]);
    insertCompany
      .mockReset()
      .mockImplementation(async (data: { target: string }) => ({ id: `id-${data.target}` }));
    bulkUpsertForCompany.mockReset().mockResolvedValue(undefined);
    findByIds.mockReset().mockResolvedValue([{ id: 't1', scan_frequency: 'weekly' }]);
    updateMany.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stamps last_scan_at and next_scan_at on every scanned thesis after a successful scan', async () => {
    mockAgentResponse(foundCompanies('Acme'));

    const result = await runMarketScreening(
      { thesis: 'SaaS', thesisIds: ['t1', 't2'] },
      { db: {} as never },
    );

    expect(result.count).toBe(1);
    expect(updateMany).toHaveBeenCalledWith(['t1', 't2'], {
      last_scan_at: NOW.toISOString(),
      next_scan_at: new Date('2026-07-10T10:00:00.000Z').toISOString(),
    });
  });

  it('stamps scan timestamps even when the scan finds no companies', async () => {
    mockAgentResponse('I could not find anything.');

    const result = await runMarketScreening(
      { thesis: 'SaaS', thesisIds: ['t1'] },
      { db: {} as never },
    );

    expect(result.count).toBe(0);
    expect(result.message).toMatch(/No companies found/);
    expect(updateMany).toHaveBeenCalledWith(
      ['t1'],
      expect.objectContaining({ last_scan_at: NOW.toISOString() }),
    );
  });

  it('stamps scan timestamps when every discovered company already exists', async () => {
    findTargetNames.mockResolvedValue(['Acme']);
    mockAgentResponse(foundCompanies('Acme'));

    const result = await runMarketScreening(
      { thesis: 'SaaS', thesisIds: ['t1'] },
      { db: {} as never },
    );

    expect(result.count).toBe(0);
    expect(result.message).toMatch(/already in the database/);
    expect(insertCompany).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      ['t1'],
      expect.objectContaining({ last_scan_at: NOW.toISOString() }),
    );
  });

  it('computes next_scan_at from the thesis scan_frequency (daily)', async () => {
    findByIds.mockResolvedValue([{ id: 't1', scan_frequency: 'daily' }]);
    mockAgentResponse(foundCompanies('Acme'));

    await runMarketScreening({ thesis: 'SaaS', thesisIds: ['t1'] }, { db: {} as never });

    expect(updateMany).toHaveBeenCalledWith(
      ['t1'],
      expect.objectContaining({
        next_scan_at: new Date('2026-07-04T10:00:00.000Z').toISOString(),
      }),
    );
  });

  it('computes next_scan_at from the thesis scan_frequency (monthly)', async () => {
    findByIds.mockResolvedValue([{ id: 't1', scan_frequency: 'monthly' }]);
    mockAgentResponse(foundCompanies('Acme'));

    await runMarketScreening({ thesis: 'SaaS', thesisIds: ['t1'] }, { db: {} as never });

    expect(updateMany).toHaveBeenCalledWith(
      ['t1'],
      expect.objectContaining({
        next_scan_at: new Date('2026-08-03T10:00:00.000Z').toISOString(),
      }),
    );
  });

  it('still supports the legacy singular thesisId', async () => {
    mockAgentResponse(foundCompanies('Acme'));

    await runMarketScreening({ thesis: 'SaaS', thesisId: 't1' }, { db: {} as never });

    expect(updateMany).toHaveBeenCalledWith(['t1'], expect.anything());
  });

  it('does not touch thesis rows when no thesis ids are provided', async () => {
    mockAgentResponse(foundCompanies('Acme'));

    await runMarketScreening({ thesis: 'SaaS' }, { db: {} as never });

    expect(findByIds).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('throws when the thesis content is empty', async () => {
    await expect(
      runMarketScreening({ thesis: '' }, { db: {} as never }),
    ).rejects.toThrow(/Investment thesis is required/);
  });
});
