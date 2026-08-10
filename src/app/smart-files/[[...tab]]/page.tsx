import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/**
 * Pre-migration deeplink bridge — see `redirectToWorkspaceScoped`.
 * Preserves tab path segments so `/smart-files/prospectus` still resolves.
 */
export default async function LegacySmartFilesRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab } = await params;
  const suffix = tab && tab.length > 0 ? `/${tab.join('/')}` : '';
  await redirectToWorkspaceScoped(`/smart-files${suffix}`, await searchParams);
}
