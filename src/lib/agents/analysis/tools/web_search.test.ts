import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreateMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: function Anthropic() {
    return { messages: { create: messagesCreateMock } };
  },
}));

import { webSearch } from './web_search';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('webSearch', () => {
  it('reports that the API key is missing when env is not configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = (await webSearch.invoke({ query: 'EBITDA multiples in tech' })) as string;

    expect(result).toContain('ANTHROPIC_API_KEY environment variable is not set');
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('returns formatted results with citations from the Anthropic response', async () => {
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
