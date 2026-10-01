'use client';

import { ReactNode, useEffect } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { loginUrlWithCallback } from '@/lib/callbackUrl';
import { isEmbedded, postToLauncher } from '@/lib/iframe';
import { Loader2 } from 'lucide-react';

/** The fields this gate actually reads off a user. Structurally compatible with
 *  both `useAuth()`'s memoized user and the server session's `user`. */
export interface ProtectedRouteUser {
  isSuperadmin: boolean;
  workspaces: readonly { slug: string }[];
}

interface ProtectedRouteProps {
  children: ReactNode;
  /**
   * The user the **server** already authenticated for this request, passed down
   * from the workspace layout.
   *
   * `useSession` starts out `loading` and only settles after a client-side
   * `GET /api/auth/session` round trip. Without this, that window renders a
   * full-screen spinner — on the server too, since SSR sees the same `loading`
   * state — so every page load showed a spinner first and the server's own
   * render was thrown away. Seeding it lets the gate open immediately on a
   * request the server already validated.
   *
   * Only trusted while `loading`; once the client session settles it wins, so
   * an expired session still redirects.
   */
  initialUser?: ProtectedRouteUser | null;
}

/**
 * Every current caller of this component lives under `/w/[workspaceSlug]/...`
 * (the `layout.tsx` there is the primary, server-side gate — this is
 * defense-in-depth for the client-hydration window). `workspaceSlug` comes
 * from the URL, not the session's globally-active `workspaceId`, so this
 * check is correct even when a tab's URL differs from the session's claim.
 */
export function ProtectedRoute({ children, initialUser }: ProtectedRouteProps) {
  const { user: sessionUser, loading } = useAuth();
  // While the client session is still resolving, fall back to the user the
  // server already authenticated. Once it settles, the client session is the
  // only source of truth — otherwise a session that expired mid-visit would
  // keep rendering against a stale server snapshot.
  const user = loading ? (sessionUser ?? initialUser ?? null) : sessionUser;
  const router = useRouter();
  const params = useParams<{ workspaceSlug?: string }>();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      // Inside the launcher iframe, redirecting to /login renders an unusable
      // login page in the frame. Ask the launcher to re-launch us with a fresh
      // `?token` instead; standalone keeps the normal /login redirect.
      if (isEmbedded()) {
        postToLauncher({ type: 'auth-expired' });
      } else {
        // Carry the page they were on, so a session that expired mid-visit
        // returns them here after signing in rather than to the picker.
        const search = searchParams.toString();
        router.replace(loginUrlWithCallback(`${pathname}${search ? `?${search}` : ''}`));
      }
      return;
    }
    // A superadmin may legitimately have zero workspace memberships (they
    // manage every workspace globally) — exempt them so they aren't bounced
    // to the picker's empty state and stranded from /admin-portal.
    if (user.isSuperadmin) return;
    const isMember = user.workspaces.some((w) => w.slug === params.workspaceSlug);
    if (!isMember) {
      router.replace('/workspace');
    }
  }, [user, loading, router, params.workspaceSlug, pathname, searchParams]);

  // Only block on the session when the server didn't hand us one to start from.
  if (loading && !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
}
