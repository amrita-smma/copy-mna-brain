import Dashboard from '@/views/Dashboard';
import { companyGraphEnabled, insightsDashboardEnabled } from '@/lib/flags';

export default async function DashboardPage() {
  const [showCompanyGraph, showInsightsDashboard] = await Promise.all([
    companyGraphEnabled().then(Boolean),
    insightsDashboardEnabled().then(Boolean),
  ]);
  return (
    <Dashboard
      showCompanyGraph={showCompanyGraph}
      showInsightsDashboard={showInsightsDashboard}
    />
  );
}
