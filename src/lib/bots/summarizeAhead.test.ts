import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage, RemoveMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { SUMMARY_WRITE_LOCK_SECONDS, summarizeThreadAhead } from './summarizeAhead';
import { SUMMARIZATION_SOURCE } from './summary';

vi.mock('./threadMiddleware', () => ({ summarizeAheadUpdate: vi.fn(async () => null) }));

const messages = [new HumanMessage({ id: 'h1', content: 'q' }), new AIMessage({ id: 'a1', content: 'a' })];
const summary = new HumanMessage({ id: 's1', content: 'Here is a summary', additional_kwargs: { lc_source: SUMMARIZATION_SOURCE } });
const update = [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), summary, messages[1]];

describe('summarizeThreadAhead', () => {
  const agent = { getThreadSnapshot: vi.fn(), replaceMessagesIfAt: vi.fn() };
  const claimTurn = vi.fn();
  const releaseTurn = vi.fn();
  const summarize = vi.fn();
  const deps = () => ({ agent, chatId: 'chat-1', claimTurn, releaseTurn, summarize });

  beforeEach(() => {
    agent.getThreadSnapshot.mockReset().mockResolvedValue({ messages, hasInterrupt: false, checkpointId: 'cp-1' });
    agent.replaceMessagesIfAt.mockReset().mockResolvedValue(true);
    claimTurn.mockReset().mockResolvedValue(true);
    releaseTurn.mockReset().mockResolvedValue(undefined);
    summarize.mockReset().mockResolvedValue(update);
  });

  it('summarizes off the lock, then writes under it only while the thread is still where it was read', async () => {
    await expect(summarizeThreadAhead(deps())).resolves.toBe('summarized');

    expect(summarize).toHaveBeenCalledWith(messages);
    // The summary came before the claim; the write and the release after it.
    expect(summarize.mock.invocationCallOrder[0]).toBeLessThan(claimTurn.mock.invocationCallOrder[0]);
    expect(claimTurn).toHaveBeenCalledWith('chat-1', SUMMARY_WRITE_LOCK_SECONDS);
    expect(agent.replaceMessagesIfAt).toHaveBeenCalledWith('chat-1', 'cp-1', update);
    expect(releaseTurn.mock.invocationCallOrder[0]).toBeGreaterThan(agent.replaceMessagesIfAt.mock.invocationCallOrder[0]);
  });

  it('uses the read the caller already has instead of reading the thread again', async () => {
    await summarizeThreadAhead({ ...deps(), known: { messages, hasInterrupt: false, checkpointId: 'cp-known' } });

    expect(agent.getThreadSnapshot).not.toHaveBeenCalled();
    expect(agent.replaceMessagesIfAt).toHaveBeenCalledWith('chat-1', 'cp-known', update);
  });

  it('does nothing under the mark, and touches neither the lock nor the thread', async () => {
    summarize.mockResolvedValue(null);

    await expect(summarizeThreadAhead(deps())).resolves.toBe('nothing_to_do');

    expect(claimTurn).not.toHaveBeenCalled();
    expect(agent.replaceMessagesIfAt).not.toHaveBeenCalled();
  });

  it('leaves a thread paused on an approval alone: its open tool calls are waiting, not history', async () => {
    agent.getThreadSnapshot.mockResolvedValue({ messages, hasInterrupt: true, checkpointId: 'cp-1' });

    await expect(summarizeThreadAhead(deps())).resolves.toBe('nothing_to_do');

    expect(summarize).not.toHaveBeenCalled();
  });

  it('drops the summary when a turn holds the thread, to try again after that turn', async () => {
    claimTurn.mockResolvedValue(false);

    await expect(summarizeThreadAhead(deps())).resolves.toBe('busy');

    expect(agent.replaceMessagesIfAt).not.toHaveBeenCalled();
    expect(releaseTurn).not.toHaveBeenCalled();
  });

  it('drops the summary when the thread moved between the read and the write, and still releases', async () => {
    agent.replaceMessagesIfAt.mockResolvedValue(false);

    await expect(summarizeThreadAhead(deps())).resolves.toBe('moved');

    expect(releaseTurn).toHaveBeenCalledWith('chat-1');
  });

  it("never writes the summarizer's own failure text over the thread", async () => {
    summarize.mockResolvedValue([
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      new HumanMessage({ content: 'Here is a summary of the conversation to date:\n\nError generating summary: 529 overloaded', additional_kwargs: { lc_source: SUMMARIZATION_SOURCE } }),
    ]);

    await expect(summarizeThreadAhead(deps())).resolves.toBe('failed');

    expect(claimTurn).not.toHaveBeenCalled();
    expect(agent.replaceMessagesIfAt).not.toHaveBeenCalled();
  });

  it('releases the lock when the write throws', async () => {
    agent.replaceMessagesIfAt.mockRejectedValue(new Error('checkpointer down'));

    await expect(summarizeThreadAhead(deps())).rejects.toThrow('checkpointer down');

    expect(releaseTurn).toHaveBeenCalledWith('chat-1');
  });
});
