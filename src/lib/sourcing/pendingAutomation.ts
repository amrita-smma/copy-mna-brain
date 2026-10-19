/**
 * Sourcing → Pending Confirmation automation settings (workspace-wide).
 *
 * Dependency-free so the route, `WorkspaceService` and the toggle component
 * share the same shape and validation.
 */

export interface PendingAutomation {
  /** Match a company to tracks and AI-screen it when it enters Pending Confirmation. */
  autoScan: boolean;
  /** After a scan: promote to L0 on an overall pass. */
  autoPromote: boolean;
  /** After a scan: drop on an overall fail. */
  autoDrop: boolean;
}

export const DEFAULT_PENDING_AUTOMATION: PendingAutomation = {
  autoScan: false,
  autoPromote: false,
  autoDrop: false,
};

/** Auto promote and auto drop act on a scan's result, so neither can be on without auto-scan. */
export function normalizePendingAutomation(input: PendingAutomation): PendingAutomation {
  return {
    autoScan: input.autoScan,
    autoPromote: input.autoScan && input.autoPromote,
    autoDrop: input.autoScan && input.autoDrop,
  };
}

/** Raised when a submitted settings payload is not `{ autoScan, autoPromote, autoDrop }` booleans. */
export class InvalidPendingAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPendingAutomationError';
  }
}

/** Validate an untrusted PUT body. All three fields are required booleans. */
export function parsePendingAutomationInput(body: unknown): PendingAutomation {
  if (!body || typeof body !== 'object') {
    throw new InvalidPendingAutomationError('Expected an object body');
  }
  const { autoScan, autoPromote, autoDrop } = body as Record<string, unknown>;
  if (
    typeof autoScan !== 'boolean' ||
    typeof autoPromote !== 'boolean' ||
    typeof autoDrop !== 'boolean'
  ) {
    throw new InvalidPendingAutomationError(
      '`autoScan`, `autoPromote` and `autoDrop` must be booleans',
    );
  }
  return normalizePendingAutomation({ autoScan, autoPromote, autoDrop });
}
