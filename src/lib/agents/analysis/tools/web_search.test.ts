import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findByCodenameMock = vi.fn();
const messagesCreateMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  PastAcquisitionRepository: function PastAcquisitionRepository() {
    return { findByCodename: findByCodenameMock };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: function Anthropic() {
    return { messages: { create: messagesCreateMock } };
  },
}));

import { resolveProjectCodenamesForWebSearch, webSearch } from './web_search';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('resolveProjectCodenamesForWebSearch', () => {
  it('passes through queries without project codenames untouched', async () => {
    const result = await resolveProjectCodenamesForWebSearch('What is the EBITDA of Acme Corp?');

    expect(result.resolvedQuery).toBe('What is the EBITDA of Acme Corp?');
    expect(result.replacements).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(findByCodenameMock).not.toHaveBeenCalled();
  });

  it('replaces matched codenames with the resolved company name', async () => {
    findByCodenameMock.mockResolvedValue({ target_co_partner: 'Acme Corp' });

    const result = await resolveProjectCodenamesForWebSearch('Tell me about Project Sunrise');

    expect(result.resolvedQuery).toBe('Tell me about Acme Corp');
    expect(result.replacements).toEqual([{ codename: 'Project Sunrise', companyName: 'Acme Corp' }]);
  });

  it('strips unresolved codenames from the query', async () => {
    findByCodenameMock.mockResolvedValue(null);

    const result = await resolveProjectCodenamesForWebSearch('What about Project Phantom?');

    expect(result.resolvedQuery).toBe('What about ?');
    expect(result.removed).toContain('Project Phantom');
  });
});

describe('webSearch', () => {
  it('reports that the API key is missing when env is not configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = (await webSearch.invoke({ query: 'EBITDA multiples in tech' })) as string;

    expect(result).toContain('ANTHROPIC_API_KEY environment variable is not set');
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('returns formatted results with citations from the Anthropic response', async () => {
    findByCodenameMock.mockResolvedValue(null);
    messagesCreateMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: 'Average EBITDA multiple is 12x.',
          citations: [{ url: 'https://example.com/report', title: 'Industry Report' }],
        },
      ],
    });

    const result = (await webSearch.invoke({ query: 'EBITDA multiples in tech' })) as string;

    expect(result).toContain("Web Search Results for 'EBITDA multiples in tech'");
    expect(result).toContain('Average EBITDA multiple is 12x.');
    expect(result).toContain('[Industry Report](https://example.com/report)');
    expect(result).toContain('CITATIONS_JSON:');
  });
});
