import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/** Pre-migration deeplink bridge — see `redirectToWorkspaceScoped`. */
export default async function LegacyPresentationRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await redirectToWorkspaceScoped('/presentation', await searchParams);
}
