/**
 * The contact insights period filter: which deals the scorecard counts, by
 * when the deal entered Brain. Pure, so the route and the client share it.
 */
export const INSIGHTS_PERIODS = ['all', '30d', '90d', 'ytd', '12m'] as const;

export type InsightsPeriod = (typeof INSIGHTS_PERIODS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export function isInsightsPeriod(value: string): value is InsightsPeriod {
  return (INSIGHTS_PERIODS as readonly string[]).includes(value);
}

/**
 * The period's start as an ISO timestamp, or undefined for all time. `ytd`
 * starts on 1 January UTC; `12m` is the same UTC day twelve months back.
 */
export function periodToSince(period: InsightsPeriod, now = new Date()): string | undefined {
  switch (period) {
    case 'all':
      return undefined;
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS).toISOString();
    case '90d':
      return new Date(now.getTime() - 90 * DAY_MS).toISOString();
    case 'ytd':
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
    case '12m': {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - 12);
      return d.toISOString();
    }
  }
}
