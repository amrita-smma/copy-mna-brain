/**
 * Hands a file dropped on the insight list to the upload page across a
 * client-side navigation. A File can't go in the URL or sessionStorage, and
 * the two pages mount separate InsightHosts, so it waits here in memory.
 *
 * The upload page peeks on mount and clears the slot once it has taken the
 * file. Peeking doesn't consume it, so a dev StrictMode double-mount still
 * gets the file. A file left behind (the navigation never landed) goes
 * stale after a short while and is ignored.
 */
const STALE_AFTER_MS = 30_000;

let pending: { file: File; at: number } | null = null;

export function setPendingInsightUpload(file: File): void {
  pending = { file, at: Date.now() };
}

export function peekPendingInsightUpload(): File | null {
  if (!pending) return null;
  if (Date.now() - pending.at > STALE_AFTER_MS) {
    pending = null;
    return null;
  }
  return pending.file;
}

export function clearPendingInsightUpload(file: File): void {
  if (pending?.file === file) pending = null;
}
