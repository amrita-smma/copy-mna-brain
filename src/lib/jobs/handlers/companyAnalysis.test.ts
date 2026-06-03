import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tables } from '@/lib/repositories';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getAgentGraph: vi.fn(),
  upsertByCompanyId: vi.fn(),
  updateByCompanyId: vi.fn(),
  findById: vi.fn(),
  findByCompanyFinancials: vi.fn(),
  findByCompanyScreening: vi.fn(),
}));

vi.mock('@/lib/agents/analysis', () => ({
  getAgentGraph: mocks.getAgentGraph,
  HumanMessage: class {
    constructor(public content: string) {}
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

import { runCompanyAnalysis } from './companyAnalysis';

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
  mocks.getAgentGraph.mockReset();
  mocks.upsertByCompanyId.mockReset();
  mocks.updateByCompanyId.mockReset();
  mocks.findById.mockReset();
  mocks.findByCompanyFinancials.mockReset();
  mocks.findByCompanyScreening.mockReset();

  mocks.findById.mockResolvedValue({ id: 'co-1', target: 'Acme Corp' });
  mocks.findByCompanyFinancials.mockResolvedValue([]);
  mocks.findByCompanyScreening.mockResolvedValue(null);
  mocks.upsertByCompanyId.mockResolvedValue(undefined);
  mocks.updateByCompanyId.mockResolvedValue({} as Tables<'company_analyses'>);
  mocks.invoke.mockResolvedValue({
    messages: [{ content: VALID_ANALYSIS_JSON }],
  });
  mocks.getAgentGraph.mockResolvedValue({ invoke: mocks.invoke });
});

describe('runCompanyAnalysis', () => {
  it('passes deps.job.id as thread_id so PostgresSaver never writes a null checkpoint', async () => {
    await runCompanyAnalysis(
      { companyId: 'co-1' },
      { db: {} as never, job: { id: 'job-abc-123' } as Tables<'jobs'> },
    );

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [, config] = mocks.invoke.mock.calls[0];
    expect(config).toEqual({ configurable: { thread_id: 'job-abc-123' } });
  });
});
