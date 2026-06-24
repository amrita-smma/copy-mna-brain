import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import Presentation from '@/views/Presentation';
import { companyGraphEnabled } from '@/lib/flags';

function PresentationLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

export default async function PresentationPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return (
    <Suspense fallback={<PresentationLoading />}>
      <Presentation showCompanyGraph={showCompanyGraph} />
    </Suspense>
  );
}
