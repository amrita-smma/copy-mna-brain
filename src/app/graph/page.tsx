import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/** Pre-migration deeplink bridge — see `redirectToWorkspaceScoped`. */
export default async function LegacyGraphRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await redirectToWorkspaceScoped('/graph', await searchParams);
}
