import { afterEach, describe, expect, it, vi } from 'vitest';

const findForAgentStatsMock = vi.fn();
const findLatestByCompaniesMock = vi.fn();
const findByNameFuzzyMock = vi.fn();
const getConnectedCompaniesMock = vi.fn();
const getGraphDataMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return {
      findForAgentStats: findForAgentStatsMock,
      findByNameFuzzy: findByNameFuzzyMock,
    };
  },
  CompanyFinancialRepository: function CompanyFinancialRepository() {
    return { findLatestByCompanies: findLatestByCompaniesMock };
  },
}));

vi.mock('@/lib/services/container', () => ({
  createContainer: () => ({
    companyGraphService: {
      getConnectedCompanies: getConnectedCompaniesMock,
      getGraphData: getGraphDataMock,
    },
  }),
}));

import { getCompanyStats } from './get_company_stats';

afterEach(() => vi.clearAllMocks());

describe('getCompanyStats', () => {
  it('returns a friendly message when the database is empty', async () => {
    findForAgentStatsMock.mockResolvedValue([]);

    const result = (await getCompanyStats.invoke({})) as string;

    expect(result).toBe('No companies in the database.');
  });

  it('returns a filter-aware message when a filtered cohort is empty', async () => {
    findForAgentStatsMock.mockResolvedValue([]);

    const result = (await getCompanyStats.invoke({
      has_ai_opinion: true,
    })) as string;

    expect(result).toBe('No companies match the given filters.');
  });

  it('aggregates totals and groups by segment by default', async () => {
    findForAgentStatsMock.mockResolvedValue([
      { id: 'c1', segment: 'Tech', geography: 'US', status: 'active', source: 'inbound' },
      { id: 'c2', segment: 'Tech', geography: 'JP', status: 'active', source: 'outbound' },
      { id: 'c3', segment: 'Health', geography: 'US', status: 'dropped', source: 'inbound' },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([
      { company_id: 'c1', revenue_usd_mn: 100, ebitda_usd_mn: 20 },
      { company_id: 'c2', revenue_usd_mn: 50, ebitda_usd_mn: 10 },
      { company_id: 'c3', revenue_usd_mn: 30, ebitda_usd_mn: null },
    ]);

    const result = (await getCompanyStats.invoke({})) as string;

    expect(result).toContain('Total companies: 3');
    expect(result).toContain('Total revenue: $180.0M');
    expect(result).toContain('2 active · 1 dropped');
    expect(result).toContain('2 inbound · 1 outbound');
    expect(result).toContain('**By Segment:**');
    expect(result).toContain('| Tech | 2 |');
    expect(result).toContain('| Health | 1 |');
  });

  it('reports AI Opinion coverage and verdict split', async () => {
    findForAgentStatsMock.mockResolvedValue([
      { id: 'c1', ai_opinion_verdict: 'pass' },
      { id: 'c2', ai_opinion_verdict: 'fail' },
      { id: 'c3', ai_opinion_verdict: null },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([]);

    const result = (await getCompanyStats.invoke({})) as string;

    expect(result).toContain('With opinion: 2/3');
    expect(result).toContain('1 pass · 1 fail · 0 tentative');
  });

  it('forwards filters to the repository', async () => {
    findForAgentStatsMock.mockResolvedValue([]);

    await getCompanyStats.invoke({
      source: 'inbound',
      has_ai_opinion: false,
      ai_opinion_verdict: 'pass',
    });

    expect(findForAgentStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'inbound',
        hasAiOpinion: false,
        aiOpinionVerdict: 'pass',
      }),
    );
  });

  it('forwards created_after and created_before date filters to the repository', async () => {
    findForAgentStatsMock.mockResolvedValue([]);

    await getCompanyStats.invoke({
      created_after: '2026-01-01',
      created_before: '2026-06-30',
    });

    expect(findForAgentStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAfter: '2026-01-01',
        createdBefore: '2026-06-30',
      }),
    );
  });

  it('defaults the cohort to the L0–L5 funnel when no stage is specified', async () => {
    findForAgentStatsMock.mockResolvedValue([]);

    await getCompanyStats.invoke({});

    expect(findForAgentStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stageIn: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
      }),
    );
    expect(findForAgentStatsMock.mock.calls[0][0].stage).toBeUndefined();
  });

  it('does not apply the L0–L5 default when an explicit stage is given', async () => {
    findForAgentStatsMock.mockResolvedValue([]);

    await getCompanyStats.invoke({ stage: 'market_screening' });

    const passed = findForAgentStatsMock.mock.calls[0][0];
    expect(passed.stage).toBe('market_screening');
    expect(passed.stageIn).toBeUndefined();
  });

  it('forwards the newly exposed column filters to the repository', async () => {
    findForAgentStatsMock.mockResolvedValue([]);

    await getCompanyStats.invoke({
      is_live: true,
      workflow_status: 'NDA signed',
      advisor: 'Goldman',
      last_activity_after: '2026-01-01',
    });

    expect(findForAgentStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        isLive: true,
        workflowStatus: 'NDA signed',
        advisor: 'Goldman',
        lastActivityAfter: '2026-01-01',
      }),
    );
  });

  it('scopes the cohort to an explicit id list without the stage default', async () => {
    findForAgentStatsMock.mockResolvedValue([]);

    await getCompanyStats.invoke({ company_ids: ['c1'] });

    const passed = findForAgentStatsMock.mock.calls[0][0];
    expect(passed.ids).toEqual(['c1']);
    expect(passed.stageIn).toBeUndefined();
  });

  it('narrows the cohort to the graph neighbours of connected_to', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'anchor', target: 'Acme' });
    getConnectedCompaniesMock.mockResolvedValue([
      { company: { id: 'n1', name: 'Beta' }, type: 'PARTNER', direction: 'outgoing' },
    ]);
    findForAgentStatsMock.mockResolvedValue([]);

    await getCompanyStats.invoke({ connected_to: 'Acme' });

    expect(findForAgentStatsMock.mock.calls[0][0].ids).toEqual(['n1']);
  });

  it('errors when connected_to cannot be resolved', async () => {
    findByNameFuzzyMock.mockResolvedValue(null);

    const result = (await getCompanyStats.invoke({ connected_to: 'Ghost' })) as string;

    expect(result).toContain('**Error:**');
    expect(findForAgentStatsMock).not.toHaveBeenCalled();
  });

  it('appends multiple requested breakdowns', async () => {
    findForAgentStatsMock.mockResolvedValue([
      { id: 'c1', segment: 'Tech', geography: 'US', pipeline_stage: 'L1' },
      { id: 'c2', segment: 'Tech', geography: 'JP', pipeline_stage: 'L0' },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([]);

    const result = (await getCompanyStats.invoke({
      group_by: ['geography', 'stage'],
    })) as string;

    expect(result).toContain('**By Geography:**');
    expect(result).toContain('| US |');
    expect(result).toContain('| JP |');
    expect(result).toContain('**By Pipeline Stage:**');
    expect(result).toContain('| L1 |');
    expect(result).toContain('| L0 |');
  });
});
