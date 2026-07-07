import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/** Pre-migration deeplink bridge — see `redirectToWorkspaceScoped`. */
export default async function LegacyPipelineDealSlidesRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { dealId } = await params;
  await redirectToWorkspaceScoped(`/pipeline/${dealId}/slides`, await searchParams);
}
