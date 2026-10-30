import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveTraceAnnouncer } from './liveTrace';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveTraceAnnouncer', () => {
  it('publishes one workforce-trace frame for a burst of writes, then again for the next', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const announcer = new LiveTraceAnnouncer('ws-1', 'run-1', publish, 1_000);

    announcer.touch();
    announcer.touch();
    announcer.touch();
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('ws-1', 'workforce-trace', ['run-1']);

    announcer.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('flushes a waiting frame on stop and ignores touches after it', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const announcer = new LiveTraceAnnouncer('ws-1', 'run-1', publish, 1_000);

    announcer.touch();
    await announcer.stop();
    expect(publish).toHaveBeenCalledTimes(1);

    announcer.touch();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(publish).toHaveBeenCalledTimes(1);

    // Nothing waiting: stop publishes nothing.
    const quiet = new LiveTraceAnnouncer('ws-1', 'run-2', publish, 1_000);
    await quiet.stop();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('logs and keeps going when a publish rejects', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const announcer = new LiveTraceAnnouncer('ws-1', 'run-1', publish, 10);

    announcer.touch();
    await vi.advanceTimersByTimeAsync(10);

    expect(error).toHaveBeenCalledWith('[workforce] live trace publish failed:', expect.any(Error));
    error.mockRestore();
  });
});
