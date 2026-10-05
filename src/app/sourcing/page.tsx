import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/** Bare-path bridge into the workspace-scoped page — see `redirectToWorkspaceScoped`. */
export default async function LegacySourcingRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await redirectToWorkspaceScoped('/sourcing', await searchParams);
}
