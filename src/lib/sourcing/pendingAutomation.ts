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

/** What Scan now would queue: companies to screen, and how many lack a Company Card. */
export interface ScanNowPreview {
  companies: number;
  missingCards: number;
}

/** Average wall-clock time of one AI screening. */
export const AVERAGE_SCREENING_SECONDS = 54;

/** Average wall-clock time of generating one Company Card, which a scan does first when missing. */
export const AVERAGE_CARD_GENERATION_SECONDS = 93;

/**
 * Estimated Scan now duration in whole minutes: 54s per company screened plus
 * 93s per company that needs its Company Card generated first, rounded to the
 * nearest minute.
 */
export function estimateScanMinutes({ companies, missingCards }: ScanNowPreview): number {
  if (companies <= 0) return 0;
  const seconds =
    companies * AVERAGE_SCREENING_SECONDS +
    Math.min(Math.max(missingCards, 0), companies) * AVERAGE_CARD_GENERATION_SECONDS;
  return Math.round(seconds / 60);
}

/** The Scan now confirmation's estimate, e.g. "~12 minutes". */
export function formatScanEstimate(preview: ScanNowPreview): string {
  const minutes = estimateScanMinutes(preview);
  if (minutes < 1) return 'less than a minute';
  return `~${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
