import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTimeoutError, withToolTimeout } from './withToolTimeout';

describe('withToolTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the inner result when the function completes in time', async () => {
    const wrapped = withToolTimeout('my_tool', 5000, async (x: number) => x * 2);
    await expect(wrapped(21)).resolves.toBe(42);
  });

  it('rejects with ToolTimeoutError when the function exceeds the budget', async () => {
    const wrapped = withToolTimeout(
      'slow_tool',
      1000,
      async () => new Promise<string>(() => undefined),
    );
    const promise = wrapped();
    // Attach a rejection handler before advancing timers so the rejection
    // isn't flagged as unhandled. await is fine — Promise.race resolves with
    // whichever settles first.
    const settled = expect(promise).rejects.toBeInstanceOf(ToolTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it('attaches toolName and timeoutMs to the thrown error', async () => {
    const wrapped = withToolTimeout(
      'capiq_lookup',
      30_000,
      async () => new Promise<string>(() => undefined),
    );
    const promise = wrapped();
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'ToolTimeoutError',
      toolName: 'capiq_lookup',
      timeoutMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('rethrows the inner error when the function fails before the timeout', async () => {
    const wrapped = withToolTimeout('failing', 5000, async () => {
      throw new Error('inner-boom');
    });
    await expect(wrapped()).rejects.toThrow('inner-boom');
  });

  it('forwards arguments to the wrapped function', async () => {
    const inner = vi.fn(async (a: number, b: string) => `${a}:${b}`);
    const wrapped = withToolTimeout('my_tool', 5000, inner);
    await expect(wrapped(7, 'x')).resolves.toBe('7:x');
    expect(inner).toHaveBeenCalledWith(7, 'x');
  });

  it('clears the timer when the inner function resolves first', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const wrapped = withToolTimeout('fast', 10_000, async () => 'ok');
    await wrapped();
    expect(clearSpy).toHaveBeenCalled();
  });
});
