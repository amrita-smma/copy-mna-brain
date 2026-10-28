import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  trace: vi.fn(),
  score: vi.fn(),
}));

vi.mock('langfuse-langchain', () => ({
  CallbackHandler: class {
    langfuse = { trace: fake.trace, score: fake.score };
    flushAsync = vi.fn();
  },
}));

import {
  CHECKPOINT_WRITE_SCORE_NAME,
  getLangfuseCallbacks,
  recordTurnTiming,
  recordTurnWrites,
  resetLangfuseHandlerForTests,
  TTFT_SCORE_NAMES,
} from './langfuseClient';

const timing = {
  traceId: 'trace-1',
  stages: { thread_open: 120, turn_claimed: 400, first_token: 1300, first_text: 1900 },
  firstTokenMs: 1300,
  firstTextMs: 1900,
};

describe('recordTurnTiming', () => {
  beforeEach(() => {
    fake.trace.mockReset();
    fake.score.mockReset();
    resetLangfuseHandlerForTests();
    process.env.LANGFUSE_SECRET_KEY = 'sk';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    delete process.env.LANGFUSE_TRACING_DISABLED;
  });

  afterEach(() => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    resetLangfuseHandlerForTests();
  });

  it('adds the timeline to the trace and posts both TTFT values as scores', () => {
    getLangfuseCallbacks();

    recordTurnTiming(timing);

    expect(fake.trace).toHaveBeenCalledWith({ id: 'trace-1', metadata: { turn_timeline: timing.stages } });
    expect(fake.score).toHaveBeenCalledWith({ traceId: 'trace-1', name: TTFT_SCORE_NAMES.firstToken, value: 1300 });
    expect(fake.score).toHaveBeenCalledWith({ traceId: 'trace-1', name: TTFT_SCORE_NAMES.firstText, value: 1900 });
  });

  it('files how the tier was decided next to the timeline when the route knows', () => {
    getLangfuseCallbacks();
    const routing = { decision: 'skipped' as const, routed: null, effort: 'low', turnChars: 12, floor: false };

    recordTurnTiming({ ...timing, routing });

    expect(fake.trace).toHaveBeenCalledWith({
      id: 'trace-1',
      metadata: { turn_timeline: timing.stages, effort_routing: routing },
    });
  });

  it('skips the scores a turn never reached, and still files the stages', () => {
    getLangfuseCallbacks();

    recordTurnTiming({ ...timing, firstTokenMs: 800, firstTextMs: null });

    expect(fake.trace).toHaveBeenCalledTimes(1);
    expect(fake.score).toHaveBeenCalledTimes(1);
    expect(fake.score).toHaveBeenCalledWith(expect.objectContaining({ name: TTFT_SCORE_NAMES.firstToken }));
  });

  it('is a no-op when tracing is off and no handler was ever built', () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    expect(getLangfuseCallbacks()).toEqual([]);

    recordTurnTiming(timing);

    expect(fake.trace).not.toHaveBeenCalled();
    expect(fake.score).not.toHaveBeenCalled();
  });

  it('never throws into the turn when the client does', () => {
    getLangfuseCallbacks();
    fake.trace.mockImplementation(() => {
      throw new Error('ingestion down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => recordTurnTiming(timing)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('recordTurnWrites', () => {
  const writes = {
    traceId: 'trace-1',
    checkpoints: 7,
    writeBatches: 3,
    totalMs: 412.6,
    maxMs: 180.2,
    lastCheckpointMessages: 41,
    messagesAtStart: 33,
  };

  beforeEach(() => {
    fake.trace.mockReset();
    fake.score.mockReset();
    resetLangfuseHandlerForTests();
    process.env.LANGFUSE_SECRET_KEY = 'sk';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    delete process.env.LANGFUSE_TRACING_DISABLED;
  });

  afterEach(() => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    resetLangfuseHandlerForTests();
  });

  it('adds the writes to the trace and posts their total as a whole-ms score', () => {
    getLangfuseCallbacks();

    recordTurnWrites(writes);

    const { traceId, ...rest } = writes;
    expect(fake.trace).toHaveBeenCalledWith({ id: traceId, metadata: { checkpoint_writes: rest } });
    expect(fake.score).toHaveBeenCalledWith({ traceId, name: CHECKPOINT_WRITE_SCORE_NAME, value: 413 });
  });

  it('repeats the timeline and routing on the same update, so the last trace update is complete', () => {
    getLangfuseCallbacks();
    const routing = { decision: 'routed' as const, routed: 'medium', effort: 'medium', turnChars: 80, floor: false };

    recordTurnWrites({ ...writes, timeline: { stages: { first_text: 1900 }, routing } });

    const { traceId, ...rest } = writes;
    expect(fake.trace).toHaveBeenCalledWith({
      id: traceId,
      metadata: { turn_timeline: { first_text: 1900 }, effort_routing: routing, checkpoint_writes: rest },
    });
  });

  it('is a no-op when tracing is off', () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    expect(getLangfuseCallbacks()).toEqual([]);

    recordTurnWrites(writes);

    expect(fake.trace).not.toHaveBeenCalled();
    expect(fake.score).not.toHaveBeenCalled();
  });

  it('swallows a client failure', () => {
    getLangfuseCallbacks();
    fake.trace.mockImplementation(() => {
      throw new Error('queue full');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => recordTurnWrites(writes)).not.toThrow();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
