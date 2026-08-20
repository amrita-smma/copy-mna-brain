import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { invokeStructuredOutput, StructuredOutputError } from './structuredOutput';

describe('invokeStructuredOutput', () => {
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
});
