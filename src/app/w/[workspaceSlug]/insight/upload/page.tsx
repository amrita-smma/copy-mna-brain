import { redirect } from 'next/navigation';
import { insightsEnabled } from '@/lib/flags';
import { InsightHost } from '@/components/insights/InsightHost';

interface InsightUploadPageProps {
  params: Promise<{ workspaceSlug: string }>;
}

export default async function InsightUploadPage({ params }: InsightUploadPageProps) {
  const { workspaceSlug } = await params;
  const isEnabled = await insightsEnabled().then(Boolean);

  if (!isEnabled) {
    redirect(`/w/${workspaceSlug}/dashboard`);
  }

  return <InsightHost view="upload" />;
}
