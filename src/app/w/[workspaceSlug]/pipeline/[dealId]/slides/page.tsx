import { Suspense } from 'react';
import CompanySlides from '@/views/CompanySlides';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';

export default async function CompanySlidesPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);
  return (
    <Suspense fallback={null}>
      <CompanySlides
        showCompanyGraph={showCompanyGraph}
        showFundManagement={showFundManagement}
      />
    </Suspense>
  );
}
