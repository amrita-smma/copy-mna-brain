import { isVoteChoice, type VoteChoice } from '@/lib/voting/tally';

/**
 * Local persistence for an *unsaved* ballot draft.
 *
 * Radix unmounts an inactive `TabsContent`, so switching away from the Voting
 * tab destroys `BallotPanel` and everything typed into it. Mirroring the
 * in-progress choice + rationale into `sessionStorage` is what makes a tab
 * switch (and a page reload, and closing/reopening the dialog) non-destructive.
 *
 * This is a convenience cache, never a source of truth: it holds only work the
 * server has not accepted yet, and is cleared the moment the stored ballot
 * catches up or the ballot is submitted.
 *
 * The storage handle is injected so the logic stays unit-testable in the
 * repo's node test environment.
 */

/** The subset of the Web Storage API this module needs. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoredBallotDraft {
  choice: VoteChoice | null;
  bodyHtml: string;
}

const KEY_PREFIX = 'mna:vote-draft:';

/** Namespaced per voting round, so two rounds never share a draft. */
export function ballotDraftKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/**
 * `window.sessionStorage`, or `null` when it is unavailable — server render, or
 * a browser that throws on access (Safari private mode, storage disabled).
 * Callers treat `null` as "persistence off", not as an error.
 */
export function browserDraftStorage(): DraftStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Read a stored draft. Returns `null` for a missing, unparseable or
 * structurally invalid entry — a corrupt cache must fall back to the server
 * values rather than break the ballot.
 */
export function readBallotDraft(
  storage: DraftStorage | null,
  sessionId: string,
): StoredBallotDraft | null {
  if (!storage || !sessionId) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(ballotDraftKey(sessionId));
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { choice, bodyHtml } = parsed as Record<string, unknown>;
    if (typeof bodyHtml !== 'string') return null;
    // A choice from an older release (or a tampered value) must not reach the
    // ballot as if it were selectable.
    if (choice != null && !isVoteChoice(choice)) return null;
    return { choice: (choice ?? null) as VoteChoice | null, bodyHtml };
  } catch {
    return null;
  }
}

/** Persist a draft. Silently gives up if the quota is exceeded. */
export function writeBallotDraft(
  storage: DraftStorage | null,
  sessionId: string,
  draft: StoredBallotDraft,
): void {
  if (!storage || !sessionId) return;
  try {
    storage.setItem(ballotDraftKey(sessionId), JSON.stringify(draft));
  } catch {
    // Losing the cache degrades UX; it must never break saving a vote.
  }
}

export function clearBallotDraft(
  storage: DraftStorage | null,
  sessionId: string,
): void {
  if (!storage || !sessionId) return;
  try {
    storage.removeItem(ballotDraftKey(sessionId));
  } catch {
    // ignore
  }
}

/**
 * What the ballot fields should start as: the unsaved draft when there is one,
 * otherwise whatever the server has stored.
 *
 * A submitted ballot always shows the server's values — it is immutable, so a
 * leftover draft would be misleading.
 */
export function initialBallotFields(
  storage: DraftStorage | null,
  sessionId: string,
  saved: { choice: VoteChoice | null; bodyHtml: string | null; status: string },
): StoredBallotDraft {
  const fromServer: StoredBallotDraft = {
    choice: saved.choice,
    bodyHtml: saved.bodyHtml ?? '',
  };
  if (saved.status === 'submitted') return fromServer;
  return readBallotDraft(storage, sessionId) ?? fromServer;
}
