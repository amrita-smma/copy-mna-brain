import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/**
 * Pre-migration deeplink bridge — see `redirectToWorkspaceScoped`. This is
 * the one real deeplink surface (`emailNotificationService.ts` has been
 * mailing `/ai-workforce/tasks/<runId>` links), so it matters that this
 * keeps resolving even after the route move.
 */
export default async function LegacyAiWorkforceRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ taskSlug?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { taskSlug } = await params;
  const suffix = taskSlug && taskSlug.length > 0 ? `/${taskSlug.join('/')}` : '';
  await redirectToWorkspaceScoped(`/ai-workforce${suffix}`, await searchParams);
}
