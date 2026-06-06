import { apiRequest } from '@/lib/api/client';
import type { DashboardActivity } from '@/lib/services/dashboardActivityService';

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
