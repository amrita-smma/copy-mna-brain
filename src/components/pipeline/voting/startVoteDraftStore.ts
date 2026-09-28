import type { DraftStorage } from './ballotDraftStore';
import { isDeadlineDay, isDeadlineTime } from '@/lib/voting/deadline';

/**
 * Local persistence for a half-completed *Start Vote* wizard.
 *
 * Same problem the ballot draft solves: Radix unmounts an inactive
 * `TabsContent`, so glancing at Overview destroys `StartVotePanel` and with it
 * the panel the initiator just assembled. Mirroring the wizard into
 * `sessionStorage` makes a tab switch (and a reload) non-destructive.
 *
 * Keyed by company rather than by round — the round the wizard would create
 * does not exist yet. It does record the round it was launched *from*
 * (`afterSessionId`, `null` when there was none), and a read that does not
 * match the round on screen is refused: a wizard abandoned before someone else
 * opened a round must never resurface on top of that round's results.
 *
 * Purely a convenience cache: it is dropped the moment the wizard is abandoned
 * back to its idle step or the round is actually started.
 */

/** The steps worth restoring — `idle` means there is nothing in progress. */
export type StartVoteStep = 'voters' | 'deadline';

export interface StoredStartVoteDraft {
  /**
   * The round the wizard was launched from — the completed round behind a
   * "Vote again", or `null` when the company had no round at all.
   */
  afterSessionId: string | null;
  step: StartVoteStep;
  voterIds: string[];
  /**
   * The picker's two fields, stored as it renders them (`YYYY-MM-DD` /
   * `HH:mm`) rather than as an absolute instant — restoring the wizard must
   * put back the wall-clock deadline the initiator was looking at.
   */
  deadlineDay: string;
  deadlineTime: string;
}

const KEY_PREFIX = 'mna:start-vote-draft:';

/** Namespaced per company, so two open companies never share a wizard. */
export function startVoteDraftKey(companyId: string): string {
  return `${KEY_PREFIX}${companyId}`;
}

const isStep = (value: unknown): value is StartVoteStep =>
  value === 'voters' || value === 'deadline';

/**
 * Read the wizard stored for this company, but only if it was launched from
 * `afterSessionId` — the round currently on screen. A draft belonging to any
 * other round is stale by definition and is refused.
 *
 * Also returns `null` for a missing, unparseable or structurally invalid entry
 * — a corrupt cache must drop the user back at the start button rather than
 * into a broken form.
 */
export function readStartVoteDraft(
  storage: DraftStorage | null,
  companyId: string,
  afterSessionId: string | null,
): StoredStartVoteDraft | null {
  if (!storage || !companyId) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(startVoteDraftKey(companyId));
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { afterSessionId: storedAfter, step, voterIds, deadlineDay, deadlineTime } =
      parsed as Record<string, unknown>;
    if (storedAfter !== null && typeof storedAfter !== 'string') return null;
    if (storedAfter !== afterSessionId) return null;
    if (!isStep(step)) return null;
    if (!Array.isArray(voterIds) || voterIds.some((id) => typeof id !== 'string')) {
      return null;
    }
    if (!isDeadlineDay(deadlineDay) || !isDeadlineTime(deadlineTime)) return null;
    return {
      afterSessionId: storedAfter,
      step,
      voterIds: voterIds as string[],
      deadlineDay,
      deadlineTime,
    };
  } catch {
    return null;
  }
}

/** Persist a wizard. Silently gives up if the quota is exceeded. */
export function writeStartVoteDraft(
  storage: DraftStorage | null,
  companyId: string,
  draft: StoredStartVoteDraft,
): void {
  if (!storage || !companyId) return;
  try {
    storage.setItem(startVoteDraftKey(companyId), JSON.stringify(draft));
  } catch {
    // Losing the cache degrades UX; it must never break starting a round.
  }
}

export function clearStartVoteDraft(
  storage: DraftStorage | null,
  companyId: string,
): void {
  if (!storage || !companyId) return;
  try {
    storage.removeItem(startVoteDraftKey(companyId));
  } catch {
    // ignore
  }
}

/**
 * Whether a resumable wizard is mid-flight for this company against the round
 * on screen. The tab uses this to decide that the start flow — not the previous
 * round's results — is what the user was last looking at.
 */
export function hasStartVoteDraft(
  storage: DraftStorage | null,
  companyId: string,
  afterSessionId: string | null,
): boolean {
  return readStartVoteDraft(storage, companyId, afterSessionId) !== null;
}
