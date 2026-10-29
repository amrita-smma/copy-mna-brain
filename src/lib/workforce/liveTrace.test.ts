import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveTraceCallbackHandler } from './liveTrace';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveTraceCallbackHandler', () => {
  it('publishes one workforce frame for a burst of model and tool callbacks', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = new LiveTraceCallbackHandler('ws-1', 'run-1', publish, 1_000);

    handler.handleLLMEnd();
    handler.handleToolEnd();
    handler.handleToolError();
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('ws-1', 'workforce', ['run-1']);

    handler.handleLLMEnd();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('logs and keeps going when a publish rejects', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = new LiveTraceCallbackHandler('ws-1', 'run-1', publish, 10);

    handler.handleToolEnd();
    await vi.advanceTimersByTimeAsync(10);

    expect(error).toHaveBeenCalledWith('[workforce] live trace publish failed:', expect.any(Error));
    error.mockRestore();
  });
});
