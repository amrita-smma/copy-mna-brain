import { Suspense } from 'react';
import Dashboard from '@/views/Dashboard';
import { GoogleSsoTokenGate } from '@/components/auth/GoogleSsoTokenGate';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function DashboardPage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return (
    <Suspense fallback={null}>
      <GoogleSsoTokenGate>
        <Dashboard showCrm={showCrm} showAiWorkforce={showAiWorkforce} />
      </GoogleSsoTokenGate>
    </Suspense>
  );
}
