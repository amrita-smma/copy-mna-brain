import { Suspense } from 'react';
import AIDiscovery from '@/views/AIDiscovery';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function AIDiscoveryPage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return (
    <Suspense fallback={null}>
      <AIDiscovery showCrm={showCrm} showAiWorkforce={showAiWorkforce} />
    </Suspense>
  );
}
