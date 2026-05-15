import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, setTitle, createDb } = vi.hoisted(() => ({
  invoke: vi.fn(),
  setTitle: vi.fn(),
  createDb: vi.fn(),
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    invoke = invoke;
  },
}));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockAiWorkforceQueueRepository {
    setTitle = setTitle;
  }
  return {
    ...actual,
    AiWorkforceQueueRepository: MockAiWorkforceQueueRepository,
  };
});

vi.mock('@/lib/server/db', () => ({ createDb }));

import { generateWorkforceTitle } from './title';

describe('generateWorkforceTitle', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    invoke.mockReset();
    setTitle.mockReset();
    createDb.mockReset();
    createDb.mockReturnValue({});
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('returns null and skips repo write when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await generateWorkforceTitle('r1', 'hello');

    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('persists trimmed title and returns it on success', async () => {
    invoke.mockResolvedValueOnce({ content: '  Korean TIM search  ' });

    const result = await generateWorkforceTitle('r2', 'Find Korean TIMs.');

    expect(result).toBe('Korean TIM search');
    expect(setTitle).toHaveBeenCalledWith('r2', 'Korean TIM search');
  });

  it('caps the title at 80 chars', async () => {
    const longTitle = 'word '.repeat(40); // 200 chars
    invoke.mockResolvedValueOnce({ content: longTitle });

    const result = await generateWorkforceTitle('r3', 'long prompt');

    expect(result?.length).toBeLessThanOrEqual(80);
    expect(setTitle).toHaveBeenCalledWith('r3', expect.any(String));
    const persisted = setTitle.mock.calls[0][1] as string;
    expect(persisted.length).toBeLessThanOrEqual(80);
  });

  it('returns null when the LLM returns an empty string', async () => {
    invoke.mockResolvedValueOnce({ content: '   ' });

    const result = await generateWorkforceTitle('r4', 'prompt');

    expect(result).toBeNull();
    expect(setTitle).not.toHaveBeenCalled();
  });

  it('swallows LLM errors and returns null', async () => {
    invoke.mockRejectedValueOnce(new Error('rate limited'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await generateWorkforceTitle('r5', 'prompt');

    expect(result).toBeNull();
    expect(setTitle).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

