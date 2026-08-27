import Dashboard from '@/views/Dashboard';
import { insightsDashboardEnabled } from '@/lib/flags';

export default async function DashboardPage() {
  const showInsightsDashboard = await insightsDashboardEnabled().then(Boolean);
  return <Dashboard showInsightsDashboard={showInsightsDashboard} />;
}
