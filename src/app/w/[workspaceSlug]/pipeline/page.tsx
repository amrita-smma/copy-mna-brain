import { Suspense } from 'react';
import Pipeline from '@/views/Pipeline';
import { Loader2 } from 'lucide-react';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';

function PipelineLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

export default async function PipelinePage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);
  return (
    <Suspense fallback={<PipelineLoading />}>
      <Pipeline
        showCompanyGraph={showCompanyGraph}
        showFundManagement={showFundManagement}
      />
    </Suspense>
  );
}
