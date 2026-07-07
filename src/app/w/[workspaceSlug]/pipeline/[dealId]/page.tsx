import { Suspense } from 'react';
import CompanyDetail from '@/views/CompanyDetail';
import { companyGraphEnabled } from '@/lib/flags';

export default async function CompanyDetailPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return (
    <Suspense fallback={null}>
      <CompanyDetail showCompanyGraph={showCompanyGraph} />
    </Suspense>
  );
}
