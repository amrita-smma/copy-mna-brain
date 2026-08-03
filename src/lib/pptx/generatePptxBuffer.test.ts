import { describe, it, expect, vi } from 'vitest';
import {
  extractPptxFileId,
  stripIncompleteTrailingToolUse,
  runPptxSkillUntilFileId,
  isTransientAnthropicError,
  withTransientAnthropicRetries,
  formatPptxGenerationError,
} from './generatePptxBuffer';

describe('extractPptxFileId', () => {
  it('returns null when there are no tool result blocks', () => {
    expect(extractPptxFileId([{ type: 'text' }])).toBeNull();
  });

  it('extracts file_id from code_execution_tool_result', () => {
    const id = extractPptxFileId([
      {
        type: 'code_execution_tool_result',
        content: {
          type: 'code_execution_result',
          content: [{ file_id: 'file_abc' }],
        },
      },
    ]);
    expect(id).toBe('file_abc');
  });

  it('extracts file_id from bash_code_execution_tool_result and prefers the last', () => {
    const id = extractPptxFileId([
      {
        type: 'bash_code_execution_tool_result',
        content: {
          type: 'bash_code_execution_result',
          content: [{ file_id: 'file_first' }, { file_id: 'file_last' }],
        },
      },
    ]);
    expect(id).toBe('file_last');
  });

  it('extracts file_id when tool result content is a flat array', () => {
    const id = extractPptxFileId([
      {
        type: 'code_execution_tool_result',
        content: [{ file_id: 'file_flat' }],
      },
    ]);
    expect(id).toBe('file_flat');
  });

  it('extracts file_id when result.content is a single object', () => {
    const id = extractPptxFileId([
      {
        type: 'code_execution_tool_result',
        content: {
          type: 'code_execution_result',
          content: { file_id: 'file_obj' },
        },
      },
    ]);
    expect(id).toBe('file_obj');
  });

  it('prefers a named .pptx over a later non-pptx file_id', () => {
    const id = extractPptxFileId([
      {
        type: 'code_execution_tool_result',
        content: {
          type: 'code_execution_result',
          content: [
            { file_id: 'file_pptx', filename: 'deck.pptx' },
            { file_id: 'file_png', filename: 'chart.png' },
          ],
        },
      },
    ]);
    expect(id).toBe('file_pptx');
  });
});

describe('stripIncompleteTrailingToolUse', () => {
  it('removes a trailing server_tool_use block', () => {
    const content = [
      { type: 'text', text: 'working' },
      { type: 'server_tool_use', id: 'tu_1', name: 'code_execution', input: {} },
    ] as never;
    expect(stripIncompleteTrailingToolUse(content)).toEqual([
      { type: 'text', text: 'working' },
    ]);
  });

  it('leaves complete content unchanged', () => {
    const content = [
      { type: 'text', text: 'done' },
      {
        type: 'bash_code_execution_tool_result',
        content: { type: 'bash_code_execution_result', content: [] },
      },
    ] as never;
    expect(stripIncompleteTrailingToolUse(content)).toEqual(content);
  });
});

describe('isTransientAnthropicError', () => {
  it('detects overloaded_error JSON payloads', () => {
    expect(
      isTransientAnthropicError({
        message: JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
      }),
    ).toBe(true);
  });

  it('detects status 529 / 429', () => {
    expect(isTransientAnthropicError({ status: 529 })).toBe(true);
    expect(isTransientAnthropicError({ status: 429 })).toBe(true);
    expect(isTransientAnthropicError({ status: 400 })).toBe(false);
  });
});

describe('formatPptxGenerationError', () => {
  it('maps overloaded errors to a friendly message', () => {
    expect(
      formatPptxGenerationError({
        message: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
    ).toMatch(/overloaded/i);
  });

  it('surfaces message from non-Error objects', () => {
    expect(formatPptxGenerationError({ message: 'skill container died' })).toBe(
      'skill container died',
    );
  });
});

describe('withTransientAnthropicRetries', () => {
  it('retries overloaded errors then succeeds', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 529, error: { type: 'overloaded_error' } })
      .mockResolvedValueOnce('ok');

    await expect(
      withTransientAnthropicRetries(fn, {
        maxRetries: 2,
        backoffSeconds: [1, 2],
        sleepFn,
      }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it('does not retry non-transient errors', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error('bad request'));

    await expect(
      withTransientAnthropicRetries(fn, { maxRetries: 3, sleepFn }),
    ).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('aborts when the wall-clock deadline has already passed', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(
      withTransientAnthropicRetries(fn, { deadlineMs: Date.now() - 1 }),
    ).rejects.toThrow(/ran out of time/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('runPptxSkillUntilFileId', () => {
  it('returns the file_id from the first successful response', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      container: { id: 'ctr_1' },
      content: [
        {
          type: 'bash_code_execution_tool_result',
          content: {
            type: 'bash_code_execution_result',
            content: [{ file_id: 'file_ok' }],
          },
        },
      ],
    });

    const result = await runPptxSkillUntilFileId('make a deck', { createMessage });
    expect(result.fileId).toBe('file_ok');
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('continues after max_tokens until a file_id appears', async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: 'max_tokens',
        container: { id: 'ctr_1' },
        content: [
          { type: 'thinking', thinking: 'planning' },
          { type: 'text', text: 'building…' },
          { type: 'server_tool_use', id: 'tu_1', name: 'code_execution', input: {} },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        container: { id: 'ctr_1' },
        content: [
          {
            type: 'bash_code_execution_tool_result',
            content: {
              type: 'bash_code_execution_result',
              content: [{ file_id: 'file_continued' }],
            },
          },
        ],
      });

    const result = await runPptxSkillUntilFileId('make a deck', { createMessage });
    expect(result.fileId).toBe('file_continued');
    expect(createMessage).toHaveBeenCalledTimes(2);

    // Continuation is a fresh short user message in the same container — not
    // a replay of prior assistant/tool blocks (those blew past 1M tokens).
    const secondCallMessages = createMessage.mock.calls[1][0] as Array<{
      role: string;
      content: unknown;
    }>;
    expect(secondCallMessages).toHaveLength(1);
    expect(secondCallMessages[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Continue the in-progress'),
    });
    expect(createMessage.mock.calls[1][1]).toEqual(
      expect.objectContaining({ containerId: 'ctr_1' }),
    );
  });

  it('continues after pause_turn with a slim container-scoped message', async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: 'pause_turn',
        container: { id: 'ctr_2' },
        content: [{ type: 'text', text: 'still working' }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        container: { id: 'ctr_2' },
        content: [
          {
            type: 'bash_code_execution_tool_result',
            content: {
              type: 'bash_code_execution_result',
              content: [{ file_id: 'file_paused' }],
            },
          },
        ],
      });

    const result = await runPptxSkillUntilFileId('make a deck', { createMessage });
    expect(result.fileId).toBe('file_paused');

    const secondCallMessages = createMessage.mock.calls[1][0] as Array<{ role: string }>;
    expect(secondCallMessages.map((m) => m.role)).toEqual(['user']);
    expect(createMessage.mock.calls[1][1]).toEqual(
      expect.objectContaining({ containerId: 'ctr_2' }),
    );
  });

  it('throws when continuations are exhausted without a file_id', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      stop_reason: 'max_tokens',
      container: { id: 'ctr_3' },
      content: [{ type: 'text', text: 'incomplete' }],
    });

    await expect(
      runPptxSkillUntilFileId('make a deck', {
        createMessage,
        maxContinuations: 1,
      }),
    ).rejects.toThrow(/did not return a file_id/);
  });
});
