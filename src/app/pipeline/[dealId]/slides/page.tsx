import { Suspense } from 'react';
import CompanySlides from '@/views/CompanySlides';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function CompanySlidesPage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return (
    <Suspense fallback={null}>
      <CompanySlides showCrm={showCrm} showAiWorkforce={showAiWorkforce} />
    </Suspense>
  );
}
