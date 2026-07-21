import { apiRequest } from '@/lib/api/client';
import type {
  DashboardActivity,
  DashboardOverview,
  FeedEvent,
  FeedFilter,
  FeedPage,
} from '@/lib/services/dashboardActivityService';
import type {
  DashboardInsights,
  InsightsSettings,
  InsightsSettingsWithMeta,
} from '@/lib/services/dashboardInsightsService';
import type { DailyPulse } from '@/lib/services/dailyPulseService';

export async function getDashboardActivity(params: {
  from: Date;
  to: Date;
}): Promise<DashboardActivity> {
  const search = new URLSearchParams();
  search.set('from', params.from.toISOString());
  search.set('to', params.to.toISOString());
  return apiRequest<DashboardActivity>(
    `/api/dashboard/activity?${search.toString()}`,
  );
}

/**
 * Fetch the "added" cohort snapshot backing the dashboard's tally sections
 * (Total Companies Added, Recap, Pipeline Stages). All three reconcile because
 * they derive from this single payload.
 */
export async function getDashboardOverview(params: {
  from: Date;
  to: Date;
}): Promise<DashboardOverview> {
  const search = new URLSearchParams();
  search.set('from', params.from.toISOString());
  search.set('to', params.to.toISOString());
  return apiRequest<DashboardOverview>(
    `/api/dashboard/overview?${search.toString()}`,
  );
}

/**
 * Fetch the "Today's Recap" daily pipeline pulse. Generated once per UTC day by
 * the `daily-pulse` cron and stored in `daily_pulse`; this is a cheap cache read
 * that returns `null` when the pulse hasn't been generated yet (it never
 * triggers the expensive on-the-fly generation — call {@link refreshDailyPulse}
 * for that).
 */
export async function getDailyPulse(): Promise<DailyPulse | null> {
  return apiRequest<DailyPulse | null>('/api/dashboard/pulse');
}

/**
 * Generate (or regenerate) today's pulse on demand — the "Generate now" action.
 * Runs the Analyst agent inline, so this can take tens of seconds; the caller
 * should show progress. Returns the freshly generated pulse.
 */
export async function refreshDailyPulse(): Promise<DailyPulse> {
  return apiRequest<DailyPulse>('/api/dashboard/pulse?refresh=1');
}

/** Fetch one page of the merged activity feed (newest first) for infinite scroll. */
export async function getDashboardFeed(params: {
  from: Date;
  to: Date;
  offset: number;
  limit: number;
  filter?: FeedFilter;
}): Promise<FeedPage> {
  const search = new URLSearchParams();
  search.set('from', params.from.toISOString());
  search.set('to', params.to.toISOString());
  search.set('offset', String(params.offset));
  search.set('limit', String(params.limit));
  if (params.filter) search.set('filter', params.filter);
  return apiRequest<FeedPage>(`/api/dashboard/feed?${search.toString()}`);
}

/**
 * Fetch a single company's complete activity timeline (newest first). Used to
 * hydrate a feed carousel with every event, independent of feed pagination.
 */
export async function getCompanyTimeline(companyId: string): Promise<FeedEvent[]> {
  return apiRequest<FeedEvent[]>(
    `/api/dashboard/company-timeline/${encodeURIComponent(companyId)}`,
  );
}

/** Fetch the aggregated Insights dashboard (funnel, breakdowns, AI throughput). */
export async function getDashboardInsights(params: {
  from: Date;
  to: Date;
}): Promise<DashboardInsights> {
  const search = new URLSearchParams();
  search.set('from', params.from.toISOString());
  search.set('to', params.to.toISOString());
  return apiRequest<DashboardInsights>(
    `/api/dashboard/insights?${search.toString()}`,
  );
}

/** Fetch the editable Insights settings (funnel targets + conversion band) plus
 * audit metadata (who last changed them, and when). */
export async function getInsightsSettings(): Promise<InsightsSettingsWithMeta> {
  return apiRequest<InsightsSettingsWithMeta>('/api/dashboard/insights/settings');
}

/** Persist updated Insights settings; returns the sanitised, saved value + meta. */
export async function updateInsightsSettings(
  settings: InsightsSettings,
): Promise<InsightsSettingsWithMeta> {
  return apiRequest<InsightsSettingsWithMeta>('/api/dashboard/insights/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}
