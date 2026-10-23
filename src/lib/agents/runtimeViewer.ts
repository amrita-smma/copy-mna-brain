import type { RunnableConfig } from '@langchain/core/runnables';

/**
 * Who a tool call runs for, read from the runtime config — never from a tool
 * argument, so the model cannot pick whose private data it reads.
 */
export interface RuntimeViewer {
  /** An AI Workforce run (`agentRole: 'workforce'`). */
  workforce: boolean;
  /**
   * The chat's signed-in user (`userId`), else the user who started the
   * Workforce run (`triggered_by_user_id`); null when there is neither.
   */
  userId: string | null;
}

export function runtimeViewer(runtime?: RunnableConfig): RuntimeViewer {
  const config = runtime?.configurable as Record<string, unknown> | undefined;
  const id = config?.userId ?? config?.triggered_by_user_id;
  return {
    workforce: config?.agentRole === 'workforce',
    userId: typeof id === 'string' && id.trim() ? id.trim() : null,
  };
}
