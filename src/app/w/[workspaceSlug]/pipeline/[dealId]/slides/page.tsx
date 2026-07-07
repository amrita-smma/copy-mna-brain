import { Suspense } from 'react';
import CompanySlides from '@/views/CompanySlides';
import { companyGraphEnabled } from '@/lib/flags';

export default async function CompanySlidesPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return (
    <Suspense fallback={null}>
      <CompanySlides showCompanyGraph={showCompanyGraph} />
    </Suspense>
  );
}
