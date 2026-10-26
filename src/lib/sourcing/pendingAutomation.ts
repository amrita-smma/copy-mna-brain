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

/** A number of companies to screen, and how many of them lack a Company Card. */
export interface ScanCount {
  companies: number;
  missingCards: number;
}

/** A track a pending company is matched to, for Scan now's track selector. */
export interface ScanNowTrack {
  id: string;
  title: string;
}

/**
 * What Scan now could queue right now: one entry per active Pending
 * Confirmation company not already queued, with the tracks it is matched to —
 * as the Pipeline's Track filter resolves them (`resolveTrackIds`: its saved
 * matches, else the keyword suggestion; `[]` when neither — it is matched
 * during the scan) — and whether it has a Company Card. The dialog derives its per-track counts and the total
 * for the selected tracks from these.
 */
export interface ScanNowPreview {
  tracks: ScanNowTrack[];
  companies: Array<{ trackIds: string[]; hasCard: boolean }>;
}

/**
 * Which pending companies a Scan now queues: those matched to any of
 * `trackIds`, plus those matched to no track when `includeUnmatched`. A
 * matched company is screened against the selected tracks it is matched to
 * only ({@link selectedTrackIdsFor}).
 */
export interface ScanNowSelection {
  trackIds: string[];
  includeUnmatched: boolean;
}

/** Whether a company matched to `companyTrackIds` falls inside `selection`. */
export function isInScanSelection(
  companyTrackIds: readonly string[],
  selection: ScanNowSelection,
): boolean {
  if (companyTrackIds.length === 0) return selection.includeUnmatched;
  return companyTrackIds.some((id) => selection.trackIds.includes(id));
}

/**
 * The selected tracks a company matched to `companyTrackIds` is screened
 * against — each one separately. `[]` for an unmatched company.
 */
export function selectedTrackIdsFor(
  companyTrackIds: readonly string[],
  selection: ScanNowSelection,
): string[] {
  return companyTrackIds.filter((id) => selection.trackIds.includes(id));
}

/** Each track with the number of pending companies matched to it, plus the unmatched count. */
export function countScanCompaniesByTrack(preview: ScanNowPreview): {
  tracks: Array<ScanNowTrack & { companies: number }>;
  unmatched: number;
} {
  const counts = new Map<string, number>();
  let unmatched = 0;
  for (const c of preview.companies) {
    if (c.trackIds.length === 0) unmatched += 1;
    for (const id of c.trackIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return {
    tracks: preview.tracks.map((t) => ({ ...t, companies: counts.get(t.id) ?? 0 })),
    unmatched,
  };
}

/**
 * What a Scan now over `selection` queues: each company counted once, however
 * many selected tracks it is matched to.
 */
export function countScanSelection(
  preview: ScanNowPreview,
  selection: ScanNowSelection,
): ScanCount {
  const selected = preview.companies.filter((c) => isInScanSelection(c.trackIds, selection));
  return {
    companies: selected.length,
    missingCards: selected.filter((c) => !c.hasCard).length,
  };
}

/** Raised when a submitted Scan now body is not a valid {@link ScanNowSelection}. */
export class InvalidScanNowSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScanNowSelectionError';
  }
}

/**
 * Validate an untrusted Scan now POST body. `null`/`undefined` (no body) means
 * every pending company and returns `null`.
 */
export function parseScanNowSelection(body: unknown): ScanNowSelection | null {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'object') {
    throw new InvalidScanNowSelectionError('Expected an object body');
  }
  const { trackIds, includeUnmatched } = body as Record<string, unknown>;
  if (
    !Array.isArray(trackIds) ||
    !trackIds.every((id) => typeof id === 'string') ||
    typeof includeUnmatched !== 'boolean'
  ) {
    throw new InvalidScanNowSelectionError(
      '`trackIds` must be an array of strings and `includeUnmatched` a boolean',
    );
  }
  return { trackIds: [...new Set(trackIds as string[])], includeUnmatched };
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
export function estimateScanMinutes({ companies, missingCards }: ScanCount): number {
  if (companies <= 0) return 0;
  const seconds =
    companies * AVERAGE_SCREENING_SECONDS +
    Math.min(Math.max(missingCards, 0), companies) * AVERAGE_CARD_GENERATION_SECONDS;
  return Math.round(seconds / 60);
}

/** The Scan now confirmation's estimate, e.g. "~12 minutes". */
export function formatScanEstimate(count: ScanCount): string {
  const minutes = estimateScanMinutes(count);
  if (minutes < 1) return 'less than a minute';
  return `~${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
