import { describe, it, expect, vi } from 'vitest';
import { TurnTimer } from './turnTimer';

function makeTimer() {
  let t = 1000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const sink = vi.fn();
  return { timer: new TurnTimer('turn-1', now, sink), advance, sink };
}

describe('TurnTimer', () => {
  it('records cumulative milliseconds per stage, in finishing order', () => {
    const { timer, advance } = makeTimer();
    advance(12);
    timer.mark('auth');
    advance(300);
    timer.mark('thread_open');
    advance(1500);
    timer.mark('first_token');

    expect(timer.at('auth')).toBe(12);
    expect(timer.at('thread_open')).toBe(312);
    expect(timer.at('first_token')).toBe(1812);
    expect(Object.keys(timer.stages())).toEqual(['auth', 'thread_open', 'first_token']);
  });

  it('keeps the first mark for a stage and reports null for one that never finished', () => {
    const { timer, advance } = makeTimer();
    advance(10);
    timer.mark('router');
    advance(10);
    timer.mark('router');

    expect(timer.at('router')).toBe(10);
    expect(timer.at('memory_recall')).toBeNull();
  });

  it('logs one line with the total and the stages, and only once', () => {
    const { timer, advance, sink } = makeTimer();
    advance(5);
    timer.mark('auth');
    advance(95);
    timer.log();
    timer.log();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toBe('[chat] turn-1 timeline total=100ms stages={"auth":5}');
  });
});
