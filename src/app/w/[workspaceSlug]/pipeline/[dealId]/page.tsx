import { Suspense } from 'react';
import CompanyDetail from '@/views/CompanyDetail';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { redirectUnlessRecordExists } from '@/lib/recordRedirect';

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; dealId: string }>;
}) {
  const { workspaceSlug, dealId } = await params;
  const { companyService } = createContainer(createDb(), await getActiveWorkspaceId());
  await redirectUnlessRecordExists(
    dealId,
    (companyId) => companyService.exists(companyId),
    `/w/${workspaceSlug}/pipeline`,
  );

  return (
    <Suspense fallback={null}>
      <CompanyDetail />
    </Suspense>
  );
}
