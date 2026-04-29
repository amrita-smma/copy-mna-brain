import { afterEach, describe, expect, it, vi } from 'vitest';

const findAllMock = vi.fn();
const findLatestByCompaniesMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return { findAll: findAllMock };
  },
  CompanyFinancialRepository: function CompanyFinancialRepository() {
    return { findLatestByCompanies: findLatestByCompaniesMock };
  },
}));

import { getCompanyStats } from './get_company_stats';

afterEach(() => vi.clearAllMocks());

describe('getCompanyStats', () => {
  it('returns a friendly message when the database is empty', async () => {
    findAllMock.mockResolvedValue([]);

    const result = (await getCompanyStats.invoke({})) as string;

    expect(result).toBe('No companies in the database.');
  });

  it('aggregates totals and groups by segment by default', async () => {
    findAllMock.mockResolvedValue([
      { id: 'c1', segment: 'Tech', geography: 'US' },
      { id: 'c2', segment: 'Tech', geography: 'JP' },
      { id: 'c3', segment: 'Health', geography: 'US' },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([
      { company_id: 'c1', revenue_usd_mn: 100, ebitda_usd_mn: 20 },
      { company_id: 'c2', revenue_usd_mn: 50, ebitda_usd_mn: 10 },
      { company_id: 'c3', revenue_usd_mn: 30, ebitda_usd_mn: null },
    ]);

    const result = (await getCompanyStats.invoke({})) as string;

    expect(result).toContain('Total Companies: 3');
    expect(result).toContain('Total Revenue (latest year): $180.0M');
    expect(result).toContain('**By Segment:**');
    expect(result).toContain('| Tech | 2 |');
    expect(result).toContain('| Health | 1 |');
  });

  it('switches to grouping by geography when requested', async () => {
    findAllMock.mockResolvedValue([
      { id: 'c1', segment: 'Tech', geography: 'US' },
      { id: 'c2', segment: 'Tech', geography: 'JP' },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([]);

    const result = (await getCompanyStats.invoke({ group_by: 'geography' })) as string;

    expect(result).toContain('**By Geography:**');
    expect(result).toContain('| US |');
    expect(result).toContain('| JP |');
  });
});
