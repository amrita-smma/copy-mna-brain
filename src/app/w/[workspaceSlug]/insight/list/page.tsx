import { redirect } from 'next/navigation';
import { insightsEnabled } from '@/lib/flags';
import { InsightHost } from '@/components/insights/InsightHost';

interface InsightListPageProps {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}

export default async function InsightListPage({ params, searchParams }: InsightListPageProps) {
  const { workspaceSlug } = await params;
  const { tab } = await searchParams;
  const isEnabled = await insightsEnabled().then(Boolean);

  if (!isEnabled) {
    redirect(`/w/${workspaceSlug}/dashboard`);
  }

  return <InsightHost view="list" listTab={tab === 'templates' ? 'templates' : 'insights'} />;
}
