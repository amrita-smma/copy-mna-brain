import { redirect } from 'next/navigation';
import { insightsEnabled } from '@/lib/flags';

interface InsightPageProps {
  params: Promise<{ workspaceSlug: string }>;
}

// The List page is the Insight home; this route only redirects old links.
export default async function InsightPage({ params }: InsightPageProps) {
  const { workspaceSlug } = await params;
  const isEnabled = await insightsEnabled().then(Boolean);

  if (!isEnabled) {
    redirect(`/w/${workspaceSlug}/dashboard`);
  }

  redirect(`/w/${workspaceSlug}/insight/list`);
}
