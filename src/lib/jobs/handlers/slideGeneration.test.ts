import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { create: mocks.messagesCreate };
  }
  return { default: Anthropic };
});

import { runSlideGeneration } from './slideGeneration';

function mockResponse(text: string, stopReason: string = 'end_turn') {
  mocks.messagesCreate.mockResolvedValue({
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
  });
}

describe('runSlideGeneration', () => {
  beforeEach(() => {
    mocks.messagesCreate.mockReset();
  });

  it('throws when instruction is missing', async () => {
    await expect(runSlideGeneration({ instruction: '' })).rejects.toThrow(
      'Missing required field: instruction',
    );
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });

  it('extracts HTML from a ```html fenced code block', async () => {
    mockResponse('```html\n<div>hello</div>\n```');

    const result = await runSlideGeneration({ instruction: 'make a slide' });
    expect(result.html).toBe('<div>hello</div>');
  });

  it('strips stray triple-backtick fences when no ```html tag is present', async () => {
    mockResponse('```\n<div>hello</div>\n```');

    const result = await runSlideGeneration({ instruction: 'make a slide' });
    expect(result.html).toBe('<div>hello</div>');
  });

  it('returns raw HTML unchanged when the model omits code fences entirely', async () => {
    mockResponse('<div>hello</div>');

    const result = await runSlideGeneration({ instruction: 'make a slide' });
    expect(result.html).toBe('<div>hello</div>');
  });

  it('throws instead of returning truncated HTML when the response hit max_tokens', async () => {
    mockResponse('<div>hello, this got cut off mid-ta', 'max_tokens');

    await expect(runSlideGeneration({ instruction: 'make a slide' })).rejects.toThrow(
      /truncated/i,
    );
  });
});
