import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/** Pre-migration deeplink bridge — see `redirectToWorkspaceScoped`. */
export default async function LegacyMasterDataRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await redirectToWorkspaceScoped('/master-data', await searchParams);
}
