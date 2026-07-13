import Dashboard from '@/views/Dashboard';
import {
  companyGraphEnabled,
  insightsDashboardEnabled,
  fundManagementEnabled,
} from '@/lib/flags';

export default async function DashboardPage() {
  const [showCompanyGraph, showInsightsDashboard, showFundManagement] =
    await Promise.all([
      companyGraphEnabled().then(Boolean),
      insightsDashboardEnabled().then(Boolean),
      fundManagementEnabled().then(Boolean),
    ]);
  return (
    <Dashboard
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
      showInsightsDashboard={showInsightsDashboard}
    />
  );
}
