import { Suspense } from 'react';
import Sourcing from '@/views/Sourcing';
import { Loader2 } from 'lucide-react';

function SourcingLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

export default async function SourcingPage() {
  return (
    <Suspense fallback={<SourcingLoading />}>
      <Sourcing />
    </Suspense>
  );
}
