/**
 * Per-tool timeout wrapper. Each agent tool that calls a slow external API
 * should wrap its inner function with this helper so a single hung call
 * fails fast with a structured error instead of consuming the whole
 * job-level timeout budget. The thrown ToolTimeoutError is caught in
 * src/lib/workforce/runAgent.ts which dispatches a `request_timeout`
 * notification to the task.
 */

export class ToolTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Tool "${toolName}" did not respond within ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}

export function withToolTimeout<TArgs extends unknown[], TResult>(
  toolName: string,
  timeoutMs: number,
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ToolTimeoutError(toolName, timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([fn(...args), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
