import { Suspense } from 'react';
import Pipeline from '@/views/Pipeline';
import { Loader2 } from 'lucide-react';

function PipelineLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

export default async function PipelinePage() {
  return (
    <Suspense fallback={<PipelineLoading />}>
      <Pipeline />
    </Suspense>
  );
}
