import { Suspense } from 'react';
import Dashboard from '@/views/Dashboard';
import { GoogleSsoTokenGate } from '@/components/auth/GoogleSsoTokenGate';
import { companyGraphEnabled } from '@/lib/flags';

export default async function DashboardPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return (
    <Suspense fallback={null}>
      <GoogleSsoTokenGate>
        <Dashboard showCompanyGraph={showCompanyGraph} />
      </GoogleSsoTokenGate>
    </Suspense>
  );
}
