import { Suspense } from 'react';
import CompanyDetail from '@/views/CompanyDetail';

export default async function CompanyDetailPage() {
  return (
    <Suspense fallback={null}>
      <CompanyDetail />
    </Suspense>
  );
}
