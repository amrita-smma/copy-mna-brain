import { apiRequest } from '@/lib/api/client';
import type {
  DashboardActivity,
  FeedEvent,
  FeedFilter,
  FeedPage,
} from '@/lib/services/dashboardActivityService';
import type {
  DashboardInsights,
  InsightsSettings,
  InsightsSettingsWithMeta,
} from '@/lib/services/dashboardInsightsService';

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
