import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tables } from '@/lib/repositories';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getAgentGraph: vi.fn(),
  getStatelessAgentGraph: vi.fn(),
  upsertByCompanyId: vi.fn(),
  updateByCompanyId: vi.fn(),
  findById: vi.fn(),
  findByCompanyFinancials: vi.fn(),
  findByCompanyScreening: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('@/lib/posthog-server', () => ({
  getPostHogClient: () => ({ capture: mocks.capture }),
}));

vi.mock('@/lib/agents/analysis', () => ({
  getStatelessAgentGraph: mocks.getStatelessAgentGraph,
  HumanMessage: class {
    constructor(public content: string) {}
  },
  extractMessageText: (message: { content?: unknown } | undefined): string => {
    if (!message) return '';
    const c = message.content;
    return typeof c === 'string' ? c : '';
  },
}));

vi.mock('@/lib/agents/analysis/tools', () => ({
  getToolDescriptions: () => 'tool-descriptions',
}));

vi.mock('@/lib/repositories', () => ({
  CompanyAnalysisRepository: class {
    upsertByCompanyId = mocks.upsertByCompanyId;
    updateByCompanyId = mocks.updateByCompanyId;
  },
  CompanyRepository: class {
    findById = mocks.findById;
  },
  CompanyFinancialRepository: class {
    findByCompany = mocks.findByCompanyFinancials;
  },
  CompanyScreeningDerivedRepository: class {
    findByCompany = mocks.findByCompanyScreening;
  },
}));

import { generateCompanyCard, runCompanyAnalysis } from './companyAnalysis';

const VALID_ANALYSIS_JSON = JSON.stringify({
  business_overview: 'overview',
  business_model_summary: 'summary',
  key_takeaways: 'takeaways',
  investment_highlights: 'highlights',
  investment_risks: 'risks',
  diligence_priorities: 'priorities',
});

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.getStatelessAgentGraph.mockReset();
  mocks.upsertByCompanyId.mockReset();
  mocks.updateByCompanyId.mockReset();
  mocks.findById.mockReset();
  mocks.findByCompanyFinancials.mockReset();
  mocks.findByCompanyScreening.mockReset();
  mocks.capture.mockReset();

  mocks.findById.mockResolvedValue({ id: 'co-1', target: 'Acme Corp' });
  mocks.findByCompanyFinancials.mockResolvedValue([]);
  mocks.findByCompanyScreening.mockResolvedValue(null);
  mocks.upsertByCompanyId.mockResolvedValue(undefined);
  mocks.updateByCompanyId.mockResolvedValue({} as Tables<'company_analyses'>);
  mocks.invoke.mockResolvedValue({
    messages: [{ content: VALID_ANALYSIS_JSON }],
  });
  mocks.getStatelessAgentGraph.mockResolvedValue({ invoke: mocks.invoke });
});

describe('runCompanyAnalysis', () => {
  it('invokes the agent once and saves the structured result', async () => {
    const result = await runCompanyAnalysis(
      { companyId: 'co-1' },
      { db: {} as never, job: { id: 'job-abc-123' } as Tables<'jobs'> },
    );

    // Post-#174: company analysis runs on the stateless agent graph, which
    // has no PostgresSaver attached. The handler must use the stateless
    // variant (no thread_id needed) and not call the persistent one.
    expect(mocks.getStatelessAgentGraph).toHaveBeenCalledTimes(1);
    expect(mocks.getAgentGraph).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.updateByCompanyId).toHaveBeenCalledWith(
      'co-1',
      expect.objectContaining({ status: 'completed', business_overview: 'overview' }),
    );
    expect(result).toEqual({});
  });
});

describe('generateCompanyCard', () => {
  it('returns the parsed related companies and the analysed company name', async () => {
    mocks.updateByCompanyId.mockResolvedValue({ id: 'analysis-1' } as Tables<'company_analyses'>);
    mocks.invoke.mockResolvedValue({
      messages: [
        {
          content: JSON.stringify({
            business_overview: 'overview',
            business_model_summary: 'summary',
            key_takeaways: 'takeaways',
            investment_highlights: 'highlights',
            investment_risks: 'risks',
            diligence_priorities: 'priorities',
            related_companies: [
              { name: 'Beta Supplier', relation_type: 'SUPPLIER', notes: 'wafers' },
              { name: 'Gamma Ventures', relation_type: 'INVESTED_IN' },
            ],
          }),
        },
      ],
    });

    const result = await generateCompanyCard(
      { companyId: 'co-1' },
      { db: {} as never },
    );

    expect(result.companyName).toBe('Acme Corp');
    expect(result.relatedCompanies).toEqual([
      { name: 'Beta Supplier', relation_type: 'SUPPLIER', notes: 'wafers' },
      { name: 'Gamma Ventures', relation_type: 'INVESTED_IN' },
    ]);
    // No jobs row in the workforce path: the analysis is persisted with a null job_id.
    expect(mocks.upsertByCompanyId).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'co-1', status: 'processing', job_id: null }),
    );
  });

  it('captures a company_card_generated PostHog event on success', async () => {
    mocks.updateByCompanyId.mockResolvedValue({ id: 'analysis-1' } as Tables<'company_analyses'>);
    mocks.invoke.mockResolvedValue({
      messages: [
        {
          content: JSON.stringify({
            business_overview: 'overview',
            business_model_summary: 'summary',
            key_takeaways: 'takeaways',
            investment_highlights: 'highlights',
            investment_risks: 'risks',
            diligence_priorities: 'priorities',
            related_companies: [
              { name: 'Beta Supplier', relation_type: 'SUPPLIER' },
            ],
          }),
        },
      ],
    });

    await generateCompanyCard({ companyId: 'co-1' }, { db: {} as never });

    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'server',
        event: 'company_card_generated',
        properties: expect.objectContaining({
          company_id: 'co-1',
          company_name: 'Acme Corp',
          related_company_count: 1,
        }),
      }),
    );
  });

  it('does not capture a company_card_generated event when parsing fails', async () => {
    mocks.invoke.mockResolvedValue({
      messages: [{ content: 'not json at all' }],
    });

    await expect(
      generateCompanyCard({ companyId: 'co-1' }, { db: {} as never }),
    ).rejects.toThrow();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
