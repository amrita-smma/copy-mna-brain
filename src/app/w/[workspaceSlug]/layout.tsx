import { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';

/**
 * Membership gate for every `/w/[workspaceSlug]/...` route. `proxy.ts`
 * already redirects unauthenticated/non-member requests before this ever
 * renders — this is defense-in-depth, not the only check.
 *
 * Deliberately does NOT call `switchWorkspace`/session `update()`. Visiting a
 * `/w/<slug>/` URL must never rewrite the shared session cookie to match —
 * that would put two tabs on two different workspaces right back to fighting
 * over one cookie, undoing the whole point of URL-scoped workspaces. This
 * layout only reads and gates; it never writes session state.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceSlug: string }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const { workspaceSlug } = await params;
  const isMember =
    session.user.isSuperadmin || session.user.workspaces.some((w) => w.slug === workspaceSlug);
  if (!isMember) {
    redirect('/workspace');
  }

  return <>{children}</>;
}
