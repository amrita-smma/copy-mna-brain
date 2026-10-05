import { afterEach, describe, expect, it, vi } from 'vitest';

const findByNameFuzzyMock = vi.fn();
const findByIdOrNullMock = vi.fn();
const findByCompanyFinancialsMock = vi.fn();
const findByCompanyScreeningMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return {
      findByNameFuzzy: findByNameFuzzyMock,
      findByIdOrNull: findByIdOrNullMock,
    };
  },
  CompanyFinancialRepository: function CompanyFinancialRepository() {
    return { findByCompany: findByCompanyFinancialsMock };
  },
  CompanyScreeningDerivedRepository: function CompanyScreeningDerivedRepository() {
    return { findByCompany: findByCompanyScreeningMock };
  },
}));

vi.mock('./stageLabels', () => ({
  loadStageLabeler: vi.fn(async () => (stage: string | null | undefined) =>
    stage === 'stg-post' ? 'L6 · Post-Close' : (stage ?? null),
  ),
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

    expect(result).toContain('Please provide a company_id, or a company target name');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
    expect(findByIdOrNullMock).not.toHaveBeenCalled();
  });

  it('rejects a call with neither company_id nor company_name', async () => {
    const result = (await getCompanyDetails.invoke({})) as string;

    expect(result).toContain('Please provide a company_id, or a company target name');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
    expect(findByIdOrNullMock).not.toHaveBeenCalled();
  });

  it('looks the company up by id exactly, never by name, when company_id is given', async () => {
    findByIdOrNullMock.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      target: '杭州华友新材料',
      pipeline_stage: 'L1',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({
      company_id: '11111111-2222-3333-4444-555555555555',
      // A name is supplied too — the id must still win, since the name is what
      // resolves to a near-identically named sibling record.
      company_name: '杭州华友',
    })) as string;

    expect(findByIdOrNullMock).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
    expect(result).toContain('## Company Details: 杭州华友新材料');
  });

  it('reports a company_id that resolves to nothing without falling back to the name', async () => {
    findByIdOrNullMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({
      company_id: '11111111-2222-3333-4444-555555555555',
      company_name: 'Acme',
    })) as string;

    expect(result).toContain('No company found for company_id "11111111-2222-3333-4444-555555555555"');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed company_id rather than querying with it', async () => {
    const result = (await getCompanyDetails.invoke({ company_id: 'not-a-uuid' })) as string;

    expect(result).toContain('is not a valid UUID');
    expect(findByIdOrNullMock).not.toHaveBeenCalled();
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
  });

  it('tells the model to prefer company_id over the fuzzy name match', async () => {
    expect(getCompanyDetails.description).toContain('PREFER company_id whenever you have one');
    expect(getCompanyDetails.description).toContain(
      'Never re-resolve by name a company whose id you already have',
    );
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

  it("names the pipeline stage by the workspace's code and name, not its key", async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c-1', target: 'Acme', pipeline_stage: 'stg-post' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('**Pipeline Stage:** L6 · Post-Close');
    expect(result).not.toContain('stg-post');
  });
});
