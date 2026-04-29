import { Suspense } from 'react';
import AIDiscovery from '@/views/AIDiscovery';
import { crmEnabled } from '@/lib/flags';

export default async function AIDiscoveryPage() {
  const showCrm = Boolean(await crmEnabled());
  return (
    <Suspense fallback={null}>
      <AIDiscovery showCrm={showCrm} />
    </Suspense>
  );
}
