import { afterEach, describe, expect, it, vi } from 'vitest';

const searchForAgentMock = vi.fn();
const findLatestByCompaniesMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return { searchForAgent: searchForAgentMock };
  },
  CompanyFinancialRepository: function CompanyFinancialRepository() {
    return { findLatestByCompanies: findLatestByCompaniesMock };
  },
}));

import { queryCompanies } from './query_companies';

afterEach(() => vi.clearAllMocks());

describe('queryCompanies', () => {
  it('returns a "no companies found" message when the repo returns nothing', async () => {
    searchForAgentMock.mockResolvedValue([]);

    const result = (await queryCompanies.invoke({ segment: 'Tech' })) as string;

    expect(result).toBe('No companies found matching your criteria.');
    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ segment: 'Tech', limit: 20 }),
    );
  });

  it('renders a markdown table with latest financials joined per company', async () => {
    searchForAgentMock.mockResolvedValue([
      { id: 'c1', target: 'Acme', project_name: 'Project Alpha', segment: 'Tech', geography: 'US', watchlist_status: 'Active' },
      { id: 'c2', target: 'Beta', project_name: null, segment: 'Health', geography: 'JP', watchlist_status: null },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([
      { company_id: 'c1', revenue_usd_mn: 12.345, ebitda_usd_mn: 3.5, ev_usd_mn: 100 },
    ]);

    const result = (await queryCompanies.invoke({ search_term: 'a' })) as string;

    expect(result).toContain('Query Results (2 companies)');
    expect(result).toContain('Acme');
    expect(result).toContain('Project Alpha');
    expect(result).toContain('Target | Project | Segment');
    expect(result).toContain('$12.3');
    expect(result).toContain('Beta');
    expect(result).toContain('| - |'); // missing financials render as '-'
  });

  it('forwards the stage filter to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ stage: 'L2' });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'L2', limit: 20 }),
    );
  });

  it('forwards the name filter to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ name: 'Acme' });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme', limit: 20 }),
    );
  });

  it('forwards ownership, company_focus, source and status filters to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({
      ownership: 'family office',
      company_focus: 'SaaS',
      source: 'inbound',
      status: 'active',
    });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownership: 'family office',
        companyFocus: 'SaaS',
        source: 'inbound',
        status: 'active',
        limit: 20,
      }),
    );
  });

  it('forwards max_ebitda alongside min_ebitda to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ min_ebitda: 5, max_ebitda: 50 });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ minEbitda: 5, maxEbitda: 50, limit: 20 }),
    );
  });

  it('returns a formatted error when the search call throws', async () => {
    searchForAgentMock.mockRejectedValue(new Error('boom'));

    const result = (await queryCompanies.invoke({})) as string;

    expect(result).toContain('**Error:** boom');
  });
});
