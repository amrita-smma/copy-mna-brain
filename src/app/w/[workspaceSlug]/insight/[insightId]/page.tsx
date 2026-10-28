import { redirect } from 'next/navigation';
import { insightsEnabled } from '@/lib/flags';
import { InsightHost } from '@/components/insights/InsightHost';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { redirectUnlessRecordExists } from '@/lib/recordRedirect';

interface InsightIdPageProps {
  params: Promise<{ workspaceSlug: string; insightId: string }>;
}

export default async function InsightIdPage({ params }: InsightIdPageProps) {
  const { workspaceSlug, insightId } = await params;
  const isEnabled = await insightsEnabled().then(Boolean);

  if (!isEnabled) {
    redirect(`/w/${workspaceSlug}/dashboard`);
  }

  const workspaceId = await getActiveWorkspaceId();
  const { insightService } = createContainer(createDb(), workspaceId);
  await redirectUnlessRecordExists(
    insightId,
    (id) => insightService.exists(workspaceId, id),
    `/w/${workspaceSlug}/insight`,
  );

  return <InsightHost insightId={insightId} />;
}
