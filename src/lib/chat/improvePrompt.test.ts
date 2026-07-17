import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    invoke = invoke;
  },
}));

import { improvePrompt } from './improvePrompt';

describe('improvePrompt', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    invoke.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.clearAllMocks();
  });

  it('returns the trimmed improved prompt on success', async () => {
    invoke.mockResolvedValueOnce({ content: '  Find Korean tin smelters with >$50M EBITDA.  ' });

    const result = await improvePrompt('korean tin');

    expect(result).toBe('Find Korean tin smelters with >$50M EBITDA.');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sends the trimmed user prompt to the model', async () => {
    invoke.mockResolvedValueOnce({ content: 'improved' });

    await improvePrompt('   hello   ');

    const messages = invoke.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toBe('hello');
  });

  it('throws without calling the model when the prompt is blank', async () => {
    await expect(improvePrompt('   ')).rejects.toThrow(/empty/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('throws without calling the model when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(improvePrompt('do a thing')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the original text when the model returns the keep sentinel', async () => {
    invoke.mockResolvedValueOnce({ content: 'KEEP_ORIGINAL_PROMPT' });

    const result = await improvePrompt('  please  ');

    expect(result).toBe('please');
  });

  it('keeps the original text when the sentinel is wrapped in quotes/punctuation', async () => {
    invoke.mockResolvedValueOnce({ content: '"KEEP_ORIGINAL_PROMPT."' });

    const result = await improvePrompt('hi');

    expect(result).toBe('hi');
  });

  it('throws when the model returns an empty string', async () => {
    invoke.mockResolvedValueOnce({ content: '   ' });

    await expect(improvePrompt('prompt')).rejects.toThrow(/empty result/i);
  });

  it('caps the improved prompt length', async () => {
    invoke.mockResolvedValueOnce({ content: 'x'.repeat(5000) });

    const result = await improvePrompt('prompt');

    expect(result.length).toBeLessThanOrEqual(2000);
  });

  it('propagates model errors to the caller', async () => {
    invoke.mockRejectedValueOnce(new Error('rate limited'));

    await expect(improvePrompt('prompt')).rejects.toThrow('rate limited');
  });
});
