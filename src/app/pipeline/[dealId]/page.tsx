import { Suspense } from 'react';
import CompanyDetail from '@/views/CompanyDetail';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function CompanyDetailPage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return (
    <Suspense fallback={null}>
      <CompanyDetail showCrm={showCrm} showAiWorkforce={showAiWorkforce} />
    </Suspense>
  );
}
