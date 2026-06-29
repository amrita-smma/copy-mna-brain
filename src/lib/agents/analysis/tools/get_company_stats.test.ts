import { afterEach, describe, expect, it, vi } from 'vitest';

const findForAgentStatsMock = vi.fn();
const findLatestByCompaniesMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return { findForAgentStats: findForAgentStatsMock };
  },
  CompanyFinancialRepository: function CompanyFinancialRepository() {
    return { findLatestByCompanies: findLatestByCompaniesMock };
  },
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
