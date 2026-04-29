import { Suspense } from 'react';
import Pipeline from '@/views/Pipeline';
import { Loader2 } from 'lucide-react';
import { crmEnabled } from '@/lib/flags';

function PipelineLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

export default async function PipelinePage() {
  const showCrm = Boolean(await crmEnabled());
  return (
    <Suspense fallback={<PipelineLoading />}>
      <Pipeline showCrm={showCrm} />
    </Suspense>
  );
}
