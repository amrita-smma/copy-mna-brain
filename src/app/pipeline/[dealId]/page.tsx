import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/** Pre-migration deeplink bridge — see `redirectToWorkspaceScoped`. */
export default async function LegacyPipelineDealRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { dealId } = await params;
  await redirectToWorkspaceScoped(`/pipeline/${dealId}`, await searchParams);
}
