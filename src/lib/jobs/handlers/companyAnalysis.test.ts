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
}));

vi.mock('@/lib/agents/analysis', () => ({
  getAgentGraph: mocks.getAgentGraph,
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
  mocks.getStatelessAgentGraph.mockReset();
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
  mocks.getStatelessAgentGraph.mockResolvedValue({ invoke: mocks.invoke });
});

describe('runCompanyAnalysis', () => {
  it('uses the stateless agent graph (no checkpointer) for one-shot analysis runs', async () => {
    await runCompanyAnalysis(
      { companyId: 'co-1' },
      { db: {} as never, job: { id: 'job-abc-123' } as Tables<'jobs'> },
    );

    expect(mocks.getStatelessAgentGraph).toHaveBeenCalledTimes(1);
    expect(mocks.getAgentGraph).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [invokeArgs] = mocks.invoke.mock.calls[0];
    expect(invokeArgs).toEqual({
      messages: [expect.objectContaining({ content: expect.any(String) })],
    });
  });
});
