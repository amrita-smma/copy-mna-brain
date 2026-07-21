import type { DailyPulseRepository } from '@/lib/repositories/dailyPulseRepository';
import {
  generateDailyPulse,
  type DailyPulseGenerator,
} from '@/lib/dashboard/dailyPulseNarrator';

/** UTC calendar day (YYYY-MM-DD) of a date — the per-day cache key. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Header label, e.g. "Jul 20, 2026" (UTC, to match {@link utcDay}). */
export function formatDateLabel(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The assembled card payload: the Analyst agent's markdown, shown as-is. */
export interface DailyPulse {
  /** UTC calendar day the pulse is for (YYYY-MM-DD). */
  date: string;
  /** Display label for the header, e.g. "Jul 20, 2026". */
  dateLabel: string;
  /** The recap as GitHub-flavoured markdown, rendered verbatim in the card. */
  content: string;
  /** ISO timestamp the pulse was generated. */
  generatedAt: string;
}

export interface GetPulseOptions {
  /** Reference "today". Defaults to now. Injectable for deterministic tests. */
  now?: Date;
  /** Skip the daily cache and regenerate (the cron / ops force-refresh). */
  forceRefresh?: boolean;
}

/**
 * Produces the dashboard's "Today's Recap" daily pipeline pulse by asking the
 * existing Analyst agent for it (the agent gathers the numbers via its own data
 * tools and returns the finished markdown). The result is persisted once per UTC
 * day per workspace in the `daily_pulse` table (via {@link DailyPulseRepository}),
 * so only the first request of the day — or an explicit refresh — pays the LLM
 * cost.
 */
export class DailyPulseService {
  constructor(
    private readonly workspaceId: string,
    private readonly pulseRepo: DailyPulseRepository,
    private readonly generate: DailyPulseGenerator = generateDailyPulse,
  ) {}

  async getPulse(opts: GetPulseOptions = {}): Promise<DailyPulse> {
    const now = opts.now ?? new Date();
    const today = utcDay(now);

    if (!opts.forceRefresh) {
      const cached = await this.pulseRepo.findByDate<DailyPulse>(today);
      if (cached) return cached;
    }

    const content = await this.generate(now, this.workspaceId);
    const pulse: DailyPulse = {
      date: today,
      dateLabel: formatDateLabel(now),
      content,
      generatedAt: now.toISOString(),
    };
    await this.pulseRepo.upsert(today, pulse);
    return pulse;
  }
}
