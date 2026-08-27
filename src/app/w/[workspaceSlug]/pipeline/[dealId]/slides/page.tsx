import { Suspense } from 'react';
import CompanySlides from '@/views/CompanySlides';

export default async function CompanySlidesPage() {
  return (
    <Suspense fallback={null}>
      <CompanySlides />
    </Suspense>
  );
}
