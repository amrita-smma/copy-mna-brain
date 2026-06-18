import { apiRequest } from '@/lib/api/client';
import type {
  DashboardActivity,
  FeedFilter,
  FeedPage,
} from '@/lib/services/dashboardActivityService';

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
