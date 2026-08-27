import { afterEach, describe, expect, it, vi } from 'vitest';

const findByNameFuzzyMock = vi.fn();
const findByCompanyFinancialsMock = vi.fn();
const findByCompanyScreeningMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return { findByNameFuzzy: findByNameFuzzyMock };
  },
  CompanyFinancialRepository: function CompanyFinancialRepository() {
    return { findByCompany: findByCompanyFinancialsMock };
  },
  CompanyScreeningDerivedRepository: function CompanyScreeningDerivedRepository() {
    return { findByCompany: findByCompanyScreeningMock };
  },
}));

import { getCompanyDetails } from './get_company_details';
import { parseCompanyMentions } from '@/lib/navigation/companyMentions';

afterEach(() => vi.clearAllMocks());

describe('getCompanyDetails', () => {
  it('returns a "not found" message when the company is missing', async () => {
    findByNameFuzzyMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Ghost' })) as string;

    expect(result).toContain('No company found matching "Ghost"');
  });

  it('rejects whitespace-only input without hitting the repository', async () => {
    const result = (await getCompanyDetails.invoke({ company_name: '   ' })) as string;

    expect(result).toContain('Please provide a company target name or project name');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
  });

  it('resolves a company looked up by its project name', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      target: 'Acme',
      project_name: 'Project Alpha',
      entry_id: 7,
      pipeline_stage: 'L1',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Alpha' })) as string;

    expect(findByNameFuzzyMock).toHaveBeenCalledWith('Alpha');
    expect(result).toContain('## Company Details: Acme');
    expect(result).toContain('**Project Name:** Project Alpha');
  });

  // Feeds the chat UI's "Open <company>" chip — see `companyMentions`.
  it('appends an id-to-name manifest covering target and project name', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      id: 'c-acme',
      target: 'Acme',
      project_name: 'Project Alpha',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(parseCompanyMentions(result)).toEqual([
      { id: 'c-acme', name: 'Acme' },
      { id: 'c-acme', name: 'Project Alpha' },
    ]);
  });

  it('renders financials, screening, and basic info for a real company', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      target: 'Acme',
      project_name: 'Project Alpha',
      entry_id: 7,
      segment: 'Tech',
      geography: 'US',
      pipeline_stage: 'L1',
      comments: 'Promising',
    });
    findByCompanyFinancialsMock.mockResolvedValue([
      { fiscal_year: 2023, revenue_usd_mn: 100, ebitda_usd_mn: 20, ebitda_margin: 0.2, ev_usd_mn: 500, ev_ebitda: 25, revenue_cagr_vs_prior: null },
      { fiscal_year: 2024, revenue_usd_mn: 120, ebitda_usd_mn: 30, ebitda_margin: 0.25, ev_usd_mn: 600, ev_ebitda: 20, revenue_cagr_vs_prior: 0.2 },
    ]);
    findByCompanyScreeningMock.mockResolvedValue({
      l1_screening_result: 'pass',
      l1_rationale: 'Strong fit',
    });

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('## Company Details: Acme');
    expect(result).toContain('**Company ID (UUID):** 11111111-1111-1111-1111-111111111111');
    expect(result).toContain('**Project Name:** Project Alpha');
    expect(result).toContain('**Pipeline Stage:** L1');
    expect(result).toContain('### Revenue (USD Millions)');
    expect(result).toContain('### L1 Screening');
    expect(result).toContain('**Result:** pass');
    expect(result).toContain('Strong fit');
    expect(result).toContain('Promising');
  });
});
