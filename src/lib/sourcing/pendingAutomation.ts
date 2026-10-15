/**
 * Sourcing → Pending Confirmation automation settings (workspace-wide).
 *
 * Dependency-free so the route, `WorkspaceService` and the toggle component
 * share the same shape and validation.
 */

export interface PendingAutomation {
  /** Match a company to tracks and AI-screen it when it enters Pending Confirmation. */
  autoScan: boolean;
  /** After a scan: promote to L0 on an overall pass, drop on a fail. */
  autoDropPromote: boolean;
}

export const DEFAULT_PENDING_AUTOMATION: PendingAutomation = {
  autoScan: false,
  autoDropPromote: false,
};

/** Auto drop/promote acts on a scan's result, so it can't be on without auto-scan. */
export function normalizePendingAutomation(input: PendingAutomation): PendingAutomation {
  return {
    autoScan: input.autoScan,
    autoDropPromote: input.autoScan && input.autoDropPromote,
  };
}

/** Raised when a submitted settings payload is not `{ autoScan, autoDropPromote }` booleans. */
export class InvalidPendingAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPendingAutomationError';
  }
}

/** Validate an untrusted PUT body. Both fields are required booleans. */
export function parsePendingAutomationInput(body: unknown): PendingAutomation {
  if (!body || typeof body !== 'object') {
    throw new InvalidPendingAutomationError('Expected an object body');
  }
  const { autoScan, autoDropPromote } = body as Record<string, unknown>;
  if (typeof autoScan !== 'boolean' || typeof autoDropPromote !== 'boolean') {
    throw new InvalidPendingAutomationError('`autoScan` and `autoDropPromote` must be booleans');
  }
  return normalizePendingAutomation({ autoScan, autoDropPromote });
}
