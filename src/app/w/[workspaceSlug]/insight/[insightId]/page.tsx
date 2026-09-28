import { redirect } from 'next/navigation';
import { insightsEnabled } from '@/lib/flags';
import { InsightHost } from '@/components/insights/InsightHost';

interface InsightIdPageProps {
  params: Promise<{ workspaceSlug: string; insightId: string }>;
}

export default async function InsightIdPage({ params }: InsightIdPageProps) {
  const { workspaceSlug, insightId } = await params;
  const isEnabled = await insightsEnabled().then(Boolean);

  if (!isEnabled) {
    redirect(`/w/${workspaceSlug}/dashboard`);
  }

  return <InsightHost insightId={insightId} />;
}
