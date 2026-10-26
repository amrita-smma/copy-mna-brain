import { describe, it, expect } from 'vitest';
import { cacheUsageFromModelEnd, formatCacheUsage } from './cacheUsage';

describe('cacheUsageFromModelEnd', () => {
  it("reads LangChain's normalized usage_metadata, cache details included", () => {
    const usage = cacheUsageFromModelEnd({
      event: 'on_chat_model_end',
      data: {
        output: {
          usage_metadata: {
            input_tokens: 1200,
            output_tokens: 310,
            input_token_details: { cache_read: 24500, cache_creation: 0 },
          },
        },
      },
    });

    expect(usage).toEqual({ inputTokens: 1200, outputTokens: 310, cacheRead: 24500, cacheWrite: 0 });
  });

  it("falls back to Anthropic's raw response_metadata.usage", () => {
    const usage = cacheUsageFromModelEnd({
      data: {
        output: {
          response_metadata: {
            usage: {
              input_tokens: 50,
              output_tokens: 7,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 24500,
            },
          },
        },
      },
    });

    expect(usage).toEqual({ inputTokens: 50, outputTokens: 7, cacheRead: 0, cacheWrite: 24500 });
  });

  it('treats missing cache details as zero rather than NaN', () => {
    const usage = cacheUsageFromModelEnd({
      data: { output: { usage_metadata: { input_tokens: 10, output_tokens: 2 } } },
    });

    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it('returns null when the event carries no usage at all', () => {
    expect(cacheUsageFromModelEnd({ data: { output: { content: 'hi' } } })).toBeNull();
    expect(cacheUsageFromModelEnd({ data: {} })).toBeNull();
    expect(cacheUsageFromModelEnd(null)).toBeNull();
    expect(cacheUsageFromModelEnd('x')).toBeNull();
  });
});

describe('formatCacheUsage', () => {
  it('prints one compact line per call', () => {
    expect(
      formatCacheUsage(2, { inputTokens: 1200, outputTokens: 310, cacheRead: 24500, cacheWrite: 0 }),
    ).toBe('call=2 in=1200 cache_read=24500 cache_write=0 out=310');
  });
});
