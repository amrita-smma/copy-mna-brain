/**
 * In-app changelog / release notes, sourced from the repo's **git history on
 * `main`**.
 *
 * The data is not hand-maintained here. The "Update changelog" GitHub Action
 * (.github/workflows/changelog.yml) runs `scripts/generate-changelog.ts` on
 * every push to `main`, reads `git log`, and commits `./changelog.data.ts` (the
 * `GENERATED_CHANGELOG` re-exported below) back to `main`. So every merge to
 * `main` updates the "What's new" widget — you never edit code to publish a
 * note; you just merge.
 *
 * This module holds only the shared types and the pure transform/derivation
 * helpers (unit-tested), so the generator script and the UI agree on shape.
 */

import { GENERATED_CHANGELOG } from './changelog.data';

export type ChangeCategory = 'feature' | 'improvement' | 'fix';

/** A raw commit as read from `git log` by the generator. */
export interface RawCommit {
  hash: string;
  /** Committer date, ISO 8601 (e.g. `2026-07-24T10:00:00+07:00`). */
  date: string;
  author: string;
  /** Commit subject (first line). */
  subject: string;
}

/** A commit normalised for the changelog UI. */
export interface ChangelogEntry {
  /** Full commit SHA — stable key, also links to the commit on GitHub. */
  hash: string;
  /** Day the commit landed, `YYYY-MM-DD`. */
  date: string;
  /** Cleaned, human-readable summary. */
  subject: string;
  category: ChangeCategory;
}

/** A day's worth of changelog entries. */
export interface ChangelogDay {
  date: string;
  entries: ChangelogEntry[];
}

/**
 * Cap on how many entries the generator keeps, newest first. A "What's new"
 * widget only needs recent history; without a cap the committed data file (and
 * the initial backfill of the entire repo history) would grow unbounded. Raise
 * this if you want a longer visible history.
 */
export const MAX_CHANGELOG_ENTRIES = 200;

/** The generated, push-refreshed list of changelog entries (newest first). */
export const CHANGELOG: ChangelogEntry[] = GENERATED_CHANGELOG;

/** First 10 chars of an ISO timestamp (`YYYY-MM-DD`), or '' if not parseable. */
function isoDay(timestamp: string | null | undefined): string {
  if (!timestamp) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
  return match ? match[1] : '';
}

/**
 * Classify a commit by its subject. Checks fixes first (so "add a fix" reads as
 * a fix, not a feature), then features, else a general improvement.
 */
export function categorizeCommit(subject: string): ChangeCategory {
  const s = subject.toLowerCase();
  if (/\b(fix(e[sd])?|bug(fix)?|hotfix|patch|revert)\b/.test(s)) return 'fix';
  if (/\b(feat(ure)?|add(s|ed)?|new|introduce[sd]?)\b/.test(s)) return 'feature';
  return 'improvement';
}

/**
 * Tidy a commit subject for display: drop a trailing PR reference (`(#123)`)
 * and a leading conventional-commit prefix (`feat:`, `fix(scope):`). Falls back
 * to the original if cleaning would empty it. Left otherwise as-authored — this
 * mirrors real commit messages rather than inventing prose.
 */
export function cleanSubject(subject: string): string {
  let out = subject.trim();
  out = out.replace(/\s*\(#\d+\)\s*$/, '');
  out = out.replace(/^(\w+)(\([^)]*\))?!?:\s+/, '');
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : subject.trim();
}

const NOISE = [
  /^merge\b/i,
  /^revert\b/i,
  /\bhotfix\b/i,
  /^chore: update changelog\b/i,
];

function isNoise(commit: RawCommit): boolean {
  if (!commit.subject.trim()) return true;
  if (commit.author.toLowerCase().includes('github-actions')) return true;
  if (commit.author.toLowerCase().includes('github-bot')) return true;
  if (/\[skip.?ci\]/i.test(commit.subject)) return true;
  return NOISE.some((re) => re.test(commit.subject.trim()));
}

/**
 * Normalise raw commits into changelog entries: drop merge commits, the Action's
 * own changelog commits, and anything undateable; clean + categorise the rest;
 * sort newest-first; cap to `maxEntries`. Pure — the generator does the `git`
 * reading and passes the commits here, so this stays unit-testable.
 */
export function commitsToEntries(
  commits: RawCommit[],
  maxEntries: number = MAX_CHANGELOG_ENTRIES,
): ChangelogEntry[] {
  return commits
    .filter((c) => !isNoise(c))
    .map((c) => ({
      hash: c.hash,
      date: isoDay(c.date),
      subject: cleanSubject(c.subject),
      category: categorizeCommit(c.subject),
    }))
    .filter((e) => e.date !== '' && e.hash !== '')
    // Stable sort newest-first; git log already yields newest-first, so equal
    // dates keep their commit order.
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, maxEntries);
}

/**
 * Group entries by day, newest day first, entries within a day in their
 * existing (newest-first) order.
 */
export function groupChangelogByDay(entries: ChangelogEntry[] = CHANGELOG): ChangelogDay[] {
  const byDay = new Map<string, ChangelogEntry[]>();
  for (const entry of entries) {
    const bucket = byDay.get(entry.date);
    if (bucket) bucket.push(entry);
    else byDay.set(entry.date, [entry]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, dayEntries]) => ({ date, entries: dayEntries }));
}

/** The most recent entry date, or null when there are none. */
export function latestChangelogDate(entries: ChangelogEntry[] = CHANGELOG): string | null {
  let latest: string | null = null;
  for (const { date } of entries) {
    if (latest === null || date > latest) latest = date;
  }
  return latest;
}

/**
 * Whether there is at least one entry the viewer hasn't seen. `lastSeenDate` is
 * the latest date they've already opened the widget to (null/empty for someone
 * who never has). ISO dates compare correctly as strings.
 */
export function hasUnseenChanges(
  lastSeenDate: string | null | undefined,
  entries: ChangelogEntry[] = CHANGELOG,
): boolean {
  const latest = latestChangelogDate(entries);
  if (latest === null) return false;
  if (!lastSeenDate) return true;
  return latest > lastSeenDate;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Format an ISO `YYYY-MM-DD` day as `Jul 24, 2026`. Parsed manually (not via
 * `new Date(...)`) so the label is timezone-independent and deterministic —
 * `new Date('2026-07-24')` is UTC midnight and renders as the previous day in
 * negative-offset timezones. Returns the raw input if it isn't a valid day.
 */
export function formatChangelogDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return date;
  return `${monthName} ${Number(day)}, ${year}`;
}
