import { describe, expect, it } from 'vitest';
import { mergeHistoryTail, mergeMessageText, sameMessage, type MergeableMessage } from './historyMerge';

const msg = (id: string, role: 'user' | 'assistant', text: string): MergeableMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
});

describe('mergeMessageText', () => {
  it('joins only the text parts and trims', () => {
    expect(
      mergeMessageText({
        id: 'a',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: ' Hello ' }, { type: 'text', text: 'there' }],
      }),
    ).toBe('Hello \nthere');
    expect(mergeMessageText({ id: 'a', role: 'user' })).toBe('');
  });
});

describe('sameMessage', () => {
  it('matches on role and text, not id', () => {
    expect(sameMessage(msg('a', 'user', 'hi'), msg('b', 'user', 'hi'))).toBe(true);
    expect(sameMessage(msg('a', 'user', 'hi'), msg('a', 'assistant', 'hi'))).toBe(false);
    expect(sameMessage(msg('a', 'user', 'hi'), msg('a', 'user', 'hi!'))).toBe(false);
  });
});

describe('mergeHistoryTail', () => {
  const q1 = msg('r1', 'user', 'first question');
  const a1 = msg('r2', 'assistant', 'first answer');
  const q2 = msg('r3', 'user', 'second question');
  const a2 = msg('r4', 'assistant', 'second answer');

  it('returns prev itself when the tail is empty or confirms exactly what is shown', () => {
    const prev = [q1, a1];
    expect(mergeHistoryTail(prev, [])).toBe(prev);
    expect(mergeHistoryTail(prev, [msg('r1', 'user', 'first question'), msg('r2', 'assistant', 'first answer')])).toBe(prev);
  });

  it('appends what is new and keeps the shown objects for what the tail confirms', () => {
    const prev = [q1, a1];
    const relay = msg('r5', 'user', 'Reply from Atlas: here you go');
    const reply = msg('r6', 'assistant', 'Atlas says here you go');
    const next = mergeHistoryTail(prev, [q1, a1, relay, reply]);
    expect(next).toHaveLength(4);
    expect(next[0]).toBe(q1);
    expect(next[1]).toBe(a1);
    expect(next.slice(2)).toEqual([relay, reply]);
  });

  it('keeps the messages before the tail starts (older pages already loaded)', () => {
    const older = [msg('r0a', 'user', 'old'), msg('r0b', 'assistant', 'old answer')];
    const next = mergeHistoryTail([...older, q1, a1], [q1, a1, q2, a2]);
    expect(next.slice(0, 2)).toEqual(older);
    expect(next[0]).toBe(older[0]);
    expect(next).toHaveLength(6);
    expect(next[5]).toBe(a2);
  });

  it('keeps a turn this tab streamed under its own ids when the stored rows say the same', () => {
    const streamedQ = msg('local-q', 'user', 'second question');
    const streamedA = {
      id: 'local-a',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'second answer' }],
    };
    const relay = msg('r5', 'user', 'Reply from Atlas: done');
    const next = mergeHistoryTail([q1, a1, streamedQ, streamedA], [q1, a1, q2, a2, relay]);
    expect(next.map((m) => m.id)).toEqual(['r1', 'r2', 'local-q', 'local-a', 'r5']);
    expect(next[2]).toBe(streamedQ);
    expect(next[3]).toBe(streamedA);
  });

  it('keeps a question kept in memory for a turn the user left, once its row arrives', () => {
    const kept = msg('kept-q', 'user', 'second question');
    const next = mergeHistoryTail([q1, a1, kept], [q1, a1, q2, a2]);
    expect(next.map((m) => m.id)).toEqual(['r1', 'r2', 'kept-q', 'r4']);
    expect(next[2]).toBe(kept);
  });

  it('gives a kept message the stored stamp it lacks, and leaves one it has alone', () => {
    const streamed = msg('s1', 'assistant', 'a');
    const stamped = { ...msg('s2', 'assistant', 'b'), metadata: { createdAt: '2026-10-21T01:00:00.000Z' } };
    const prev = [streamed, stamped];
    const tail = [
      { ...msg('r1', 'assistant', 'a'), metadata: { createdAt: '2026-10-21T00:59:00.000Z' } },
      { ...msg('r2', 'assistant', 'b'), metadata: { createdAt: '2026-10-21T01:05:00.000Z' } },
    ];

    const next = mergeHistoryTail(prev, tail);

    expect(next[0]).toEqual({ ...streamed, metadata: { createdAt: '2026-10-21T00:59:00.000Z' } });
    expect(next[0]).not.toBe(streamed);
    expect(next[1]).toBe(stamped);
  });

  it('takes the server\'s message when the same id now carries other content', () => {
    const edited = msg('r2', 'assistant', 'first answer, corrected');
    const next = mergeHistoryTail([q1, a1], [q1, edited]);
    expect(next[1]).toBe(edited);
  });

  it('drops a shown message after the overlap point that the tail does not confirm (a partial reply)', () => {
    const partial = msg('local-a', 'assistant', 'half an ans');
    const next = mergeHistoryTail([q1, a1, q2, partial], [q1, a1, q2, a2]);
    expect(next.map((m) => m.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('finds the overlap by text when none of the ids match', () => {
    const streamedQ = msg('local-q', 'user', 'first question');
    const streamedA = msg('local-a', 'assistant', 'first answer');
    const next = mergeHistoryTail([streamedQ, streamedA], [q1, a1, q2]);
    expect(next.map((m) => m.id)).toEqual(['local-q', 'local-a', 'r3']);
  });

  it('appends the whole tail when nothing overlaps, and fills an empty thread', () => {
    const other = msg('x', 'assistant', 'unrelated');
    expect(mergeHistoryTail([other], [q1, a1]).map((m) => m.id)).toEqual(['x', 'r1', 'r2']);
    expect(mergeHistoryTail([], [q1, a1])).toEqual([q1, a1]);
  });

  it('does not match one shown message to two tail messages', () => {
    const dup = msg('r7', 'user', 'first question');
    const next = mergeHistoryTail([q1, a1], [q1, a1, dup]);
    expect(next.map((m) => m.id)).toEqual(['r1', 'r2', 'r7']);
    expect(next[2]).toBe(dup);
  });
});
