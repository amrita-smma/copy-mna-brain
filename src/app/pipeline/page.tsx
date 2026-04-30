import { Suspense } from 'react';
import Pipeline from '@/views/Pipeline';
import { Loader2 } from 'lucide-react';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

function PipelineLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

export default async function PipelinePage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return (
    <Suspense fallback={<PipelineLoading />}>
      <Pipeline showCrm={showCrm} showAiWorkforce={showAiWorkforce} />
    </Suspense>
  );
}
