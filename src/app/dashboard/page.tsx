import { Suspense } from 'react';
import Dashboard from '@/views/Dashboard';
import { GoogleSsoTokenGate } from '@/components/auth/GoogleSsoTokenGate';
import { companyGraphEnabled, insightsDashboardEnabled } from '@/lib/flags';

export default async function DashboardPage() {
  const [showCompanyGraph, showInsightsDashboard] = await Promise.all([
    companyGraphEnabled().then(Boolean),
    insightsDashboardEnabled().then(Boolean),
  ]);
  return (
    <Suspense fallback={null}>
      <GoogleSsoTokenGate>
        <Dashboard
          showCompanyGraph={showCompanyGraph}
          showInsightsDashboard={showInsightsDashboard}
        />
      </GoogleSsoTokenGate>
    </Suspense>
  );
}
