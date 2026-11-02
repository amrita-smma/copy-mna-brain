import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents/analysis', () => ({
  extractMessageText: vi.fn(),
  getStatelessAgentGraph: vi.fn(),
  HumanMessage: class {},
}));
vi.mock('@/lib/agents/analysis/tools', () => ({ getToolDescriptions: vi.fn(() => '') }));
vi.mock('@/lib/repositories', () => ({}));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn() }));
vi.mock('@/lib/posthog-server', () => ({ captureWorkspaceEvent: vi.fn() }));
vi.mock('@/lib/server/liveEvents', () => ({ publishLiveEvent: vi.fn() }));

import { buildScreeningPrompt } from './aiScreening';

const base = {
  toolDescriptions: '- web_search\n- valyu_search',
  companyContext: '**Company Name:** Acme',
  criteriaPrompt: 'Revenue above $50M',
};

describe('buildScreeningPrompt', () => {
  it('puts the Additional Context in its own section when the deal team wrote one', () => {
    const prompt = buildScreeningPrompt({
      ...base,
      additionalContext: { text: 'Mgmt says FY24 revenue is $80M.', truncated: false },
    });
    expect(prompt).toContain('## Additional Context (recorded by the deal team)');
    expect(prompt).toContain('Mgmt says FY24 revenue is $80M.');
  });

  it('ranks the Additional Context above web search and Valyu', () => {
    const prompt = buildScreeningPrompt({
      ...base,
      additionalContext: { text: 'Private data room figures.', truncated: false },
    });
    expect(prompt).toContain('outranks web search, Valyu');
    expect(prompt).toContain('trust the Additional Context');
    expect(prompt).not.toContain('this step is not optional');
    expect(prompt).not.toContain('every time, not only when data is missing');
  });

  it('flags a truncated Additional Context so the agent can fetch the rest', () => {
    const prompt = buildScreeningPrompt({
      ...base,
      additionalContext: { text: 'Long notes…', truncated: true },
    });
    expect(prompt).toContain('[Truncated — call get_company_details for the full text.]');
  });

  it('keeps the always-search freshness behaviour when there is no Additional Context', () => {
    for (const additionalContext of [undefined, null, { text: '', truncated: false }]) {
      const prompt = buildScreeningPrompt({ ...base, additionalContext });
      expect(prompt).toContain('this step is not optional');
      expect(prompt).not.toContain('## Additional Context');
      expect(prompt).not.toContain('outranks web search');
    }
  });

  it('inlines the criterion verbatim even when it contains replacement patterns', () => {
    const prompt = buildScreeningPrompt({ ...base, criteriaPrompt: 'Costs under $& and $1' });
    expect(prompt).toContain('Costs under $& and $1');
  });
});
