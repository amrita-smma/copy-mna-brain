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
  getLangfuseCallbacks,
  recordTurnTiming,
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
