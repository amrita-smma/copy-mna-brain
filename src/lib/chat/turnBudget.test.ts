import { describe, expect, it, vi } from 'vitest';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { createUIMessageStream, type UIMessageChunk } from 'ai';
import { formatInsightTemplateBlock } from '@/lib/insights/largeDocument';

import {
  buildBudgetNotice,
  isZeroWorkBudgetNotice,
  ZERO_WORK_NOTICE_MARKER,
  collectAbandonedTurnWork,
  summarizeAbandonedTurn,
  withBudgetWrapUp,
  WRAP_UP_DIGEST_CHARS,
  WRAP_UP_PER_TOOL_CHARS,
} from './turnBudget';
import { toThinkingMessageStream } from './thinkingStream';

const tool = (name: string, content: string) =>
  new ToolMessage({ content, name, tool_call_id: `${name}-1` });

/** Stream that yields `chunks`, then optionally fails instead of closing. */
function sourceStream(
  chunks: UIMessageChunk[],
  failWith?: unknown,
): ReadableStream<UIMessageChunk> {
  let i = 0;
  return new ReadableStream<UIMessageChunk>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
        return;
      }
      if (failWith) controller.error(failWith);
      else controller.close();
    },
  });
}

async function drain(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe('collectAbandonedTurnWork', () => {
  it('collects only the tool results that follow the last user message', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('first question'),
      new AIMessage('an earlier answer'),
      tool('stale_tool', 'from a finished turn'),
      new HumanMessage('the abandoned question'),
      new AIMessage(''),
      tool('alphasense_search', 'margin history for TSMC'),
      tool('valyu_search', 'ROIC series'),
    ];

    const work = collectAbandonedTurnWork(messages);

    expect(work.question).toBe('the abandoned question');
    expect(work.toolNames).toEqual(['alphasense_search', 'valyu_search']);
    expect(work.digest).toContain('margin history for TSMC');
    expect(work.digest).toContain('ROIC series');
    expect(work.digest).not.toContain('from a finished turn');
    expect(work.hasWork).toBe(true);
  });

  it('reports no work when the abandoned turn produced no tool results', () => {
    const work = collectAbandonedTurnWork([
      new HumanMessage('a question'),
      new AIMessage(''),
    ]);

    expect(work.toolNames).toEqual([]);
    expect(work.digest).toBe('');
    expect(work.hasWork).toBe(false);
  });

  it('reads text out of content-block arrays, not just plain strings', () => {
    const messages: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: 'text', text: 'block question' },
          { type: 'thinking', thinking: 'ignored' },
        ],
      }),
      tool('search_news', 'a headline'),
    ];

    const work = collectAbandonedTurnWork(messages);

    expect(work.question).toBe('block question');
    expect(work.digest).toContain('a headline');
  });

  it('leaves an attached insight template block out of the question', () => {
    const block = formatInsightTemplateBlock(
      { id: '00000000-0000-0000-0000-00000000e001', name: 'Market Brief' },
      '<section data-section="summary">TEMPLATE HTML</section>',
    );
    const work = collectAbandonedTurnWork([
      new HumanMessage({
        content: [
          { type: 'text', text: block },
          { type: 'text', text: 'create a BBCA insight' },
        ],
      }),
      tool('web_search', 'BBCA results'),
    ]);

    expect(work.question).toBe('create a BBCA insight');
  });

  it('truncates an oversized tool result rather than sending it whole', () => {
    const work = collectAbandonedTurnWork([
      new HumanMessage('q'),
      tool('valyu_search', 'x'.repeat(WRAP_UP_PER_TOOL_CHARS * 3)),
    ]);

    expect(work.digest).toContain('…[truncated]');
    expect(work.digest.length).toBeLessThan(WRAP_UP_PER_TOOL_CHARS * 2);
  });

  it('caps the whole digest so a long tool loop cannot blow up the wrap-up call', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      tool(`tool_${i}`, 'y'.repeat(WRAP_UP_PER_TOOL_CHARS)),
    );

    const work = collectAbandonedTurnWork([new HumanMessage('q'), ...many]);

    // Every call is still named, but the body stops at the cap.
    expect(work.toolNames).toHaveLength(40);
    expect(work.digest.length).toBeLessThan(WRAP_UP_DIGEST_CHARS * 1.2);
  });
});

describe('buildBudgetNotice', () => {
  it('names the budget in minutes and the tools that did finish', () => {
    const notice = buildBudgetNotice({
      budgetMs: 420_000,
      toolNames: ['valyu_search', 'valyu_search', 'alphasense_search'],
    });

    expect(notice).toContain('7-minute budget');
    expect(notice).toContain('3 tool calls');
    // Names are de-duplicated for display.
    expect(notice).toContain('valyu_search, alphasense_search');
  });

  it('keeps the continue offer when tools did complete', () => {
    const notice = buildBudgetNotice({ budgetMs: 180_000, toolNames: ['web_search'] });

    expect(notice).toBe(
      'This turn hit its 3-minute budget before I could write the answer. It completed 1 tool call first (web_search), and those results are kept in this thread. Ask me to continue and I will pick up from here.',
    );
    expect(isZeroWorkBudgetNotice(notice)).toBe(false);
  });

  it('never offers to continue when nothing ran, and offers the Workforce instead', () => {
    const notice = buildBudgetNotice({ budgetMs: 180_000 });

    expect(notice).toBe(
      "This turn hit its 3-minute budget before any step finished, so there is nothing to pick up from — asking me to continue would just retry the same thing. Large documents are built by the AI Workforce, section by section and without a time limit. Reply and I'll hand this to the Workforce.",
    );
    expect(notice).not.toContain('Ask me to continue');
    expect(notice).not.toContain('tool call');
    expect(isZeroWorkBudgetNotice(notice)).toBe(true);
  });

  it('treats an empty tool list as nothing ran, at any budget', () => {
    const notice = buildBudgetNotice({ budgetMs: 90_000, toolNames: [] });

    expect(notice).toContain('90-second budget');
    expect(notice).toContain(ZERO_WORK_NOTICE_MARKER);
    expect(isZeroWorkBudgetNotice(buildBudgetNotice({ budgetMs: 420_000 }))).toBe(true);
  });
});

describe('summarizeAbandonedTurn', () => {
  const messages = [
    new HumanMessage('rank the semiconductor value chain'),
    tool('alphasense_search', 'TSMC five-year median EBIT margin 52%'),
  ];

  it('answers from the gathered tool output', async () => {
    const complete = vi.fn().mockResolvedValue('Ran out of time. TSMC medians came back at 52%.');

    const text = await summarizeAbandonedTurn({ messages, budgetMs: 420_000, complete });

    expect(text).toBe('Ran out of time. TSMC medians came back at 52%.');
    expect(complete).toHaveBeenCalledTimes(1);
    const { user } = complete.mock.calls[0][0];
    expect(user).toContain('rank the semiconductor value chain');
    expect(user).toContain('TSMC five-year median EBIT margin 52%');
  });

  it.each([
    ['fails', vi.fn().mockRejectedValue(new Error('upstream 529'))],
    ['returns blank', vi.fn().mockResolvedValue('   ')],
  ])('falls back to the notice when the wrap-up call %s', async (_label, complete) => {
    const text = await summarizeAbandonedTurn({ messages, budgetMs: 420_000, complete });

    expect(text).toContain('7-minute budget');
    expect(text).toContain('alphasense_search');
  });

  it('skips the model call entirely when the turn gathered nothing, and returns the zero-work notice', async () => {
    const complete = vi.fn();

    const text = await summarizeAbandonedTurn({ messages: [], budgetMs: 90_000, complete });

    expect(complete).not.toHaveBeenCalled();
    expect(text).toContain('90-second budget');
    expect(isZeroWorkBudgetNotice(text)).toBe(true);
  });
});

describe('withBudgetWrapUp', () => {
  const passthroughChunks: UIMessageChunk[] = [
    { type: 'text-start', id: 'a' },
    { type: 'text-delta', id: 'a', delta: 'hello' },
    { type: 'text-end', id: 'a' },
  ];

  it('passes a healthy stream through untouched', async () => {
    const wrapUp = vi.fn();

    const out = await drain(
      withBudgetWrapUp(sourceStream(passthroughChunks), {
        isBudgetAbort: () => false,
        wrapUp,
      }),
    );

    expect(out).toEqual(passthroughChunks);
    expect(wrapUp).not.toHaveBeenCalled();
  });

  it('closes with the wrap-up text when the budget fired', async () => {
    const out = await drain(
      withBudgetWrapUp(sourceStream(passthroughChunks, new Error('AbortError')), {
        isBudgetAbort: () => true,
        wrapUp: async () => 'Out of time — here is what I found.',
      }),
    );

    // Everything the turn managed to stream is kept.
    expect(out.slice(0, 3)).toEqual(passthroughChunks);
    expect(out.slice(3)).toEqual([
      { type: 'text-start', id: 'turn-budget-wrapup' },
      { type: 'text-delta', id: 'turn-budget-wrapup', delta: 'Out of time — here is what I found.' },
      { type: 'text-end', id: 'turn-budget-wrapup' },
    ]);
  });

  it('propagates a non-budget error so the route can still classify it', async () => {
    const boom = new Error('recursion limit');
    const wrapUp = vi.fn();

    await expect(
      drain(
        withBudgetWrapUp(sourceStream([], boom), {
          isBudgetAbort: () => false,
          wrapUp,
        }),
      ),
    ).rejects.toThrow('recursion limit');
    expect(wrapUp).not.toHaveBeenCalled();
  });

  it('closes cleanly rather than erroring when the wrap-up itself throws', async () => {
    const out = await drain(
      withBudgetWrapUp(sourceStream(passthroughChunks, new Error('aborted')), {
        isBudgetAbort: () => true,
        wrapUp: async () => {
          throw new Error('wrap-up failed too');
        },
      }),
    );

    expect(out).toEqual(passthroughChunks);
  });
});

describe('withBudgetWrapUp composed with the real chat stream', () => {
  async function* graphAbortedByBudget() {
    yield {
      event: 'on_chat_model_stream',
      run_id: 'run-1',
      data: { chunk: { content: [{ type: 'thinking', thinking: 'Reading filings...' }] } },
    };
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    throw abort;
  }

  it('absorbs a budget abort and delivers the wrap-up instead of reaching onError', async () => {
    const onError = vi.fn(() => '');
    const chunks = await drain(
      createUIMessageStream({
        onError,
        execute: async ({ writer }) => {
          writer.merge(
            withBudgetWrapUp(toThinkingMessageStream(graphAbortedByBudget(), writer), {
              isBudgetAbort: () => true,
              wrapUp: async () => 'Out of time. TSMC at 52%.',
            }),
          );
        },
      }),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'reasoning-delta', delta: 'Reading filings...' }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'text-delta', id: 'turn-budget-wrapup', delta: 'Out of time. TSMC at 52%.' }),
    );
  });
});
