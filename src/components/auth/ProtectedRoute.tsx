'use client';

import { ReactNode, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: ReactNode;
}

/**
 * Every current caller of this component lives under `/w/[workspaceSlug]/...`
 * (the `layout.tsx` there is the primary, server-side gate — this is
 * defense-in-depth for the client-hydration window). `workspaceSlug` comes
 * from the URL, not the session's globally-active `workspaceId`, so this
 * check is correct even when a tab's URL differs from the session's claim.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useParams<{ workspaceSlug?: string }>();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
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
  }, [user, loading, router, params.workspaceSlug]);

  if (loading) {
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
