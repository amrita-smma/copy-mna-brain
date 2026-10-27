import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  FROM_BOT_KWARG,
  FROM_ROUTINE_KWARG,
  lastTurnUIMessages,
  readFromBot,
  readFromRoutine,
  toUIMessages,
} from './uiMessages';
import { SUMMARIZATION_SOURCE, SUMMARY_MARKER_TEXT } from '@/lib/bots/summary';
import {
  INSIGHT_SELECTION_KWARG,
  INSIGHT_SELECTION_PART_TYPE,
  formatInsightSelectionBlock,
} from '@/lib/insights/selectionAttachment';

describe('toUIMessages', () => {
  it('merges a tool-using turn into one assistant message with the tool result attached', () => {
    const messages = [
      new HumanMessage({ id: 'h', content: 'How many deals?' }),
      new AIMessage({ id: 'a1', content: '', tool_calls: [{ id: 'tc1', name: 'query_companies', args: { q: 1 } }] }),
      new ToolMessage({ content: '12 deals', tool_call_id: 'tc1' }),
      new AIMessage({ id: 'a2', content: 'There are 12.' }),
    ];

    expect(toUIMessages(messages)).toEqual([
      { id: 'h', role: 'user', parts: [{ type: 'text', text: 'How many deals?' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'tc1',
            toolName: 'query_companies',
            state: 'output-available',
            input: { q: 1 },
            output: { kwargs: { content: '12 deals' } },
          },
          { type: 'text', text: 'There are 12.' },
        ],
      },
    ]);
  });

  it("shows a marker, not the summary text, where a bot thread's history was summarized", () => {
    const out = toUIMessages([
      new HumanMessage({
        id: 'sum',
        content: 'Here is a summary of the conversation to date: secret details',
        additional_kwargs: { lc_source: SUMMARIZATION_SOURCE },
      }),
      new HumanMessage({ id: 'q', content: 'And now?' }),
    ]);

    expect(out).toEqual([
      { id: 'sum', role: 'assistant', parts: [{ type: 'text', text: SUMMARY_MARKER_TEXT }] },
      expect.objectContaining({ id: 'q', role: 'user' }),
    ]);
  });

  it('rebuilds an insight selection as a chip and shows only the user words (MB-583)', () => {
    const selection = {
      insightId: '00000000-0000-0000-0000-00000000e101',
      insightName: 'Weekly Weather Forecast',
      sections: [{ path: [0, 0], tags: ['div', 'h1'] }],
    };
    const out = toUIMessages([
      new HumanMessage({
        id: 'h1',
        content: [
          { type: 'text', text: formatInsightSelectionBlock(selection) },
          { type: 'text', text: 'HERE YOU GO' },
        ],
        additional_kwargs: { [INSIGHT_SELECTION_KWARG]: selection },
      }),
    ]);

    expect(out).toEqual([
      {
        id: 'h1',
        role: 'user',
        parts: [
          { type: INSIGHT_SELECTION_PART_TYPE, data: selection },
          { type: 'text', text: 'HERE YOU GO' },
        ],
      },
    ]);
  });

  it('marks a message another bot sent with the sending bot', () => {
    const [msg] = toUIMessages([
      new HumanMessage({
        id: 'h',
        content: 'Find targets',
        additional_kwargs: { [FROM_BOT_KWARG]: { id: 'copilot', name: 'Copilot' } },
      }),
    ]);
    expect(msg.metadata).toEqual({ fromBot: { id: 'copilot', name: 'Copilot' } });
  });

  it('marks a message a routine sent with the routine', () => {
    const [msg] = toUIMessages([
      new HumanMessage({
        id: 'h',
        content: 'Summarise the pipeline',
        additional_kwargs: { [FROM_ROUTINE_KWARG]: { id: 'r1', title: 'Morning pipeline' } },
      }),
    ]);
    expect(msg.metadata).toEqual({ fromRoutine: { id: 'r1', title: 'Morning pipeline' } });
  });
});

describe('lastTurnUIMessages', () => {
  it('returns only the latest turn, skipping a summary message that follows it', () => {
    const out = lastTurnUIMessages([
      new HumanMessage({ id: 'h1', content: 'first' }),
      new AIMessage({ id: 'a1', content: 'one' }),
      new HumanMessage({ id: 'h2', content: 'second' }),
      new AIMessage({ id: 'a2', content: 'two' }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['h2', 'a2']);
  });

  it('is empty for a thread with no user message', () => {
    expect(lastTurnUIMessages([new AIMessage('hi')])).toEqual([]);
  });
});

describe('readFromBot', () => {
  it('reads a well-formed sender and ignores anything else', () => {
    expect(readFromBot({ [FROM_BOT_KWARG]: { id: 'b', name: 'B' } })).toEqual({ id: 'b', name: 'B' });
    expect(readFromBot({ [FROM_BOT_KWARG]: { id: 'b' } })).toBeNull();
    expect(readFromBot(undefined)).toBeNull();
  });

  it('keeps a user mention apart from a bot mention', () => {
    expect(readFromBot({ [FROM_BOT_KWARG]: { id: 'b', name: 'B', kind: 'user_mention' } })).toEqual({
      id: 'b',
      name: 'B',
      kind: 'user_mention',
    });
    expect(readFromBot({ [FROM_BOT_KWARG]: { id: 'b', name: 'B', kind: 'other' } })).toEqual({ id: 'b', name: 'B' });
  });

  it("keeps another bot's reply-back marked as a reply, so the transcript labels it one", () => {
    expect(readFromBot({ [FROM_BOT_KWARG]: { id: 'b', name: 'B', kind: 'bot_reply' } })).toEqual({
      id: 'b',
      name: 'B',
      kind: 'bot_reply',
    });
  });

  it('keeps the other bots a fan-in reply carries, dropping malformed entries', () => {
    expect(
      readFromBot({
        [FROM_BOT_KWARG]: { id: 'b', name: 'B', kind: 'bot_reply', others: [{ id: 'c', name: 'C' }, { id: 'd' }, null] },
      }),
    ).toEqual({ id: 'b', name: 'B', kind: 'bot_reply', others: [{ id: 'c', name: 'C' }] });
    expect(readFromBot({ [FROM_BOT_KWARG]: { id: 'b', name: 'B', kind: 'bot_reply', others: [] } })).toEqual({
      id: 'b',
      name: 'B',
      kind: 'bot_reply',
    });
  });
});

describe('readFromRoutine', () => {
  it('reads a well-formed routine and ignores anything else', () => {
    expect(readFromRoutine({ [FROM_ROUTINE_KWARG]: { id: 'r', title: 'T' } })).toEqual({ id: 'r', title: 'T' });
    expect(readFromRoutine({ [FROM_ROUTINE_KWARG]: { id: 'r' } })).toBeNull();
    expect(readFromRoutine(undefined)).toBeNull();
  });
});
