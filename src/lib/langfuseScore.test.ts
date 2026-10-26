import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { scoreMock, shutdownMock, ctorMock } = vi.hoisted(() => ({
  scoreMock: vi.fn(),
  shutdownMock: vi.fn(),
  ctorMock: vi.fn(),
}));

vi.mock('langfuse', () => ({
  Langfuse: class {
    constructor(opts: unknown) {
      ctorMock(opts);
    }
    score = scoreMock;
    shutdownAsync = shutdownMock;
  },
}));

import { sendLangfuseScore } from './langfuseScore';

const score = { id: 'f1', traceId: 'q-1', name: 'user_feedback', value: -1, comment: 'thin' };

describe('sendLangfuseScore', () => {
  beforeEach(() => {
    scoreMock.mockReset();
    shutdownMock.mockReset().mockResolvedValue(undefined);
    ctorMock.mockReset();
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk');
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk');
    vi.stubEnv('LANGFUSE_TRACING_DISABLED', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sends a numeric score on the trace and drains the client before returning', async () => {
    await sendLangfuseScore(score);

    expect(scoreMock).toHaveBeenCalledWith({
      id: 'f1',
      traceId: 'q-1',
      name: 'user_feedback',
      value: -1,
      dataType: 'NUMERIC',
      comment: 'thin',
      metadata: undefined,
    });
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when Langfuse is not configured', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '');
    await sendLangfuseScore(score);
    expect(ctorMock).not.toHaveBeenCalled();
  });

  it('logs and swallows a failure instead of throwing', async () => {
    shutdownMock.mockRejectedValue(new Error('langfuse down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(sendLangfuseScore(score)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
