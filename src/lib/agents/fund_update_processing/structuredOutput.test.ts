import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { chatAnthropicInstances } = vi.hoisted(() => ({
  chatAnthropicInstances: [] as Array<{ opts: Record<string, unknown> }>,
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      chatAnthropicInstances.push(this);
    }
    withStructuredOutput = () => ({
      invoke: async () => ({ name: 'Alpha Fund', count: 42, tags: ['growth', 'tech'] }),
    });
  },
}));

import { invokeStructuredOutput, StructuredOutputError } from './structuredOutput';

describe('invokeStructuredOutput', () => {
  beforeEach(() => {
    chatAnthropicInstances.length = 0;
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-api-key');
  });

  afterEach(() => vi.unstubAllEnvs());

  const TestSchema = z.object({
    name: z.string(),
    count: z.number(),
    tags: z.array(z.string()),
  });

  it('validates and returns parsed data on successful LLM invocation', async () => {
    const mockStructuredLlm = {
      invoke: vi.fn().mockResolvedValue({
        name: 'Alpha Fund',
        count: 42,
        tags: ['growth', 'tech'],
      }),
    };

    const mockLlm = {
      withStructuredOutput: vi.fn().mockReturnValue(mockStructuredLlm),
    };

    const res = await invokeStructuredOutput({
      schema: TestSchema,
      prompt: 'Extract test data',
      llmOverride: mockLlm,
    });

    expect(res).toEqual({
      name: 'Alpha Fund',
      count: 42,
      tags: ['growth', 'tech'],
    });
    expect(mockLlm.withStructuredOutput).toHaveBeenCalledWith(TestSchema, { name: 'extract_structured_data' });
  });

  it('retries when response fails schema validation and succeeds on subsequent try', async () => {
    const mockStructuredLlm = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce({
          name: 'Invalid',
          count: 'not-a-number', // Fails z.number()
          tags: [],
        })
        .mockResolvedValueOnce({
          name: 'Valid',
          count: 100,
          tags: ['valid'],
        }),
    };

    const mockLlm = {
      withStructuredOutput: vi.fn().mockReturnValue(mockStructuredLlm),
    };

    const res = await invokeStructuredOutput({
      schema: TestSchema,
      prompt: 'Extract test data',
      maxRetries: 2,
      llmOverride: mockLlm,
    });

    expect(res).toEqual({
      name: 'Valid',
      count: 100,
      tags: ['valid'],
    });
    expect(mockStructuredLlm.invoke).toHaveBeenCalledTimes(2);
  });

  it('throws StructuredOutputError when all retries fail', async () => {
    const mockStructuredLlm = {
      invoke: vi.fn().mockResolvedValue({
        name: 'Invalid Forever',
        count: 'still-not-a-number',
        tags: [],
      }),
    };

    const mockLlm = {
      withStructuredOutput: vi.fn().mockReturnValue(mockStructuredLlm),
    };

    await expect(
      invokeStructuredOutput({
        schema: TestSchema,
        prompt: 'Extract test data',
        maxRetries: 1,
        llmOverride: mockLlm,
      }),
    ).rejects.toThrow(StructuredOutputError);

    expect(mockStructuredLlm.invoke).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it('omits outputConfig for Haiku models, which reject output_config.effort', async () => {
    await invokeStructuredOutput({ schema: TestSchema, prompt: 'x', model: 'claude-haiku-4-5-20251001' });

    expect(chatAnthropicInstances).toHaveLength(1);
    expect(chatAnthropicInstances[0].opts).not.toHaveProperty('outputConfig');
  });

  it('sends outputConfig for Sonnet models, which support effort', async () => {
    await invokeStructuredOutput({ schema: TestSchema, prompt: 'x' });

    expect(chatAnthropicInstances[0].opts).toMatchObject({ model: 'claude-sonnet-5', outputConfig: { effort: 'low' } });
  });
});
