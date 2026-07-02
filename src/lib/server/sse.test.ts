import { describe, it, expect } from 'vitest';
import { encodeSseEvent, encodeSseComment, changeEvents } from './sse';

describe('encodeSseEvent', () => {
  it('encodes a payload as a data: frame terminated by a blank line', () => {
    expect(encodeSseEvent({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it('prefixes an event: line when an event name is given', () => {
    expect(encodeSseEvent([1, 2], 'update')).toBe('event: update\ndata: [1,2]\n\n');
  });
});

describe('encodeSseComment', () => {
  it('encodes a comment line ignored by EventSource', () => {
    expect(encodeSseComment('hb')).toBe(': hb\n\n');
  });
});

describe('changeEvents', () => {
  it('emits the initial snapshot, a heartbeat when unchanged, and a data event on change', async () => {
    const snaps = ['a', 'a', 'b'];
    let i = 0;
    const gen = changeEvents<string>({
      snapshot: async () => snaps[Math.min(i, snaps.length - 1)],
      now: () => 0, // never hits maxDuration; we pull manually
      sleep: async () => {
        i++;
      },
    });

    const first = await gen.next();
    const second = await gen.next();
    const third = await gen.next();
    await gen.return(undefined);

    expect(first.value).toBe(encodeSseEvent('a'));
    expect(second.value).toBe(encodeSseComment('hb'));
    expect(third.value).toBe(encodeSseEvent('b'));
  });

  it('yields an error comment (not a throw) when snapshot fails, keeping the stream alive', async () => {
    const gen = changeEvents<string>({
      snapshot: async () => {
        throw new Error('db down');
      },
      now: () => 0,
      sleep: async () => {},
    });

    const first = await gen.next();
    await gen.return(undefined);

    expect(first.value).toBe(encodeSseComment('err'));
  });

  it('completes immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const gen = changeEvents<string>({
      snapshot: async () => 'x',
      signal: controller.signal,
    });

    expect((await gen.next()).done).toBe(true);
  });

  it('stops once maxDuration has elapsed', async () => {
    let clock = 0;
    const gen = changeEvents<string>({
      snapshot: async () => 'x',
      now: () => clock,
      maxDurationMs: 100,
      sleep: async () => {
        clock += 60; // two ticks fit, the third is past the cap
      },
    });

    const emitted: string[] = [];
    for await (const chunk of gen) emitted.push(chunk);

    expect(emitted).toHaveLength(2);
  });
});
