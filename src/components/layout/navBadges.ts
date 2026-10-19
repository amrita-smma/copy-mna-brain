import type { WorkforceNavSummary } from '@/lib/api/workforce';

/** One count chip on a nav item. */
export interface NavBadge {
  count: number;
  /** red = needs attention, amber = work in progress. */
  tone: 'red' | 'amber';
  /** A glyph inside the chip: a cross for failures, a blinking dot for live work. */
  icon?: 'cross' | 'live';
  /** Screen-reader / tooltip wording, e.g. "3 pending". */
  label: string;
  testId: string;
}

/** What a nav item shows beside its label. */
export interface NavBadges {
  badges: NavBadge[];
  /** Something is happening there right now — the rail's corner dot blinks. */
  live?: boolean;
}

/** Caps a badge count so a large backlog can't stretch the nav row. */
export function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Sourcing's Pending Confirmation backlog, as a red chip. */
export function sourcingNavBadges(pending: number): NavBadges {
  return {
    badges:
      pending > 0
        ? [{ count: pending, tone: 'red', label: `${pending} pending`, testId: 'nav-badge-sourcing' }]
        : [],
  };
}

/**
 * The AI Workforce item's chips, from the nav summary: a red cross with the
 * workspace's unseen failed runs, then a yellow chip with a blinking dot and
 * the queue (runs waiting plus runs working). Either is omitted at zero.
 */
export function workforceNavBadges(summary: WorkforceNavSummary): NavBadges {
  const badges: NavBadge[] = [];
  if (summary.unseen_failures > 0) {
    badges.push({
      count: summary.unseen_failures,
      tone: 'red',
      icon: 'cross',
      label: `${summary.unseen_failures} failed`,
      testId: 'nav-badge-ai-workforce-failures',
    });
  }
  if (summary.queue > 0) {
    badges.push({
      count: summary.queue,
      tone: 'amber',
      icon: 'live',
      label: `${summary.queue} in queue`,
      testId: 'nav-badge-ai-workforce-queue',
    });
  }
  return { badges, live: summary.queue > 0 };
}
