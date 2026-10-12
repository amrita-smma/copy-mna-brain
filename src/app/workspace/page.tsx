'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { Loader2, ArrowRight, Settings, LogOut } from 'lucide-react';
import { apiRequest } from '@/lib/api/client';
import { consentUrlWithCallback } from '@/lib/callbackUrl';

interface Membership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  roleId: string;
  roleName: string;
  isEmailSynced: boolean;
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || '?';
}

export default function WorkspacePage() {
  const { user, loading, switchWorkspace, signOut } = useAuth();
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [autoSelecting, setAutoSelecting] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);

  // `/workspace` sits outside `/w/*`, so it's never touched by the proxy.ts /
  // WorkspaceLayout consent gate — this is the standard post-login landing
  // page, and an unconsented user must never see the picker (workspace
  // names, the superadmin Admin Portal link) before agreeing to Sync's terms.
  const needsConsent = !loading && !!user && !user.hasConsented;

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (needsConsent) {
      router.replace(consentUrlWithCallback('/workspace'));
    }
  }, [needsConsent, router]);

  useEffect(() => {
    if (loading || !user || needsConsent) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiRequest<Membership[]>('/api/workspaces');
        if (!cancelled) setMemberships(data ?? []);
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          router.replace('/login');
          return;
        }
        if (!cancelled) setMemberships([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, user, needsConsent, router]);

  // Single-membership users skip the picker entirely — except superadmins,
  // who need a chance to reach the Admin Portal link below rather than being
  // bounced straight into /chat before they can click it.
  useEffect(() => {
    if (!memberships || memberships.length !== 1 || autoSelecting || user?.isSuperadmin) return;
    setAutoSelecting(true);
    (async () => {
      try {
        await switchWorkspace(memberships[0].workspaceId);
        router.push(`/w/${memberships[0].workspaceSlug}/chat`);
      } catch {
        // Reset so the picker (rendered below the loader) becomes reachable
        // instead of leaving the user stuck on the spinner forever.
        setAutoSelecting(false);
        toast.error('Could not enter workspace — please try again');
      }
    })();
  }, [memberships, autoSelecting, switchWorkspace, router, user?.isSuperadmin]);

  const handleSelect = async (membership: Membership) => {
    setIsNavigating(true);
    try {
      await switchWorkspace(membership.workspaceId);
      router.push(`/w/${membership.workspaceSlug}/chat`);
    } catch {
      setIsNavigating(false);
      toast.error('Could not enter workspace — please try again');
    }
  };

  const showLoader = loading || !user || needsConsent || memberships === null || autoSelecting || isNavigating;

  if (showLoader) {
    return (
      <div className="relative flex min-h-screen items-center justify-center">
        <div className="relative z-10">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const displayName = user.name?.trim() || user.email || 'there';

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      <div className="relative z-10 w-full max-w-3xl">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            {memberships.length === 0 ? "You're not in a workspace yet" : 'Select a workspace'}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {memberships.length === 0
              ? `Hi ${displayName}, ask your admin to add you to a workspace to get started.`
              : `Welcome back, ${displayName}. Choose which workspace you'd like to enter.`}
          </p>
        </div>

        {memberships.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {memberships.map((membership) => (
              <button
                key={membership.workspaceId}
                type="button"
                onClick={() => handleSelect(membership)}
                className="group flex items-center gap-4 rounded-2xl border bg-card p-4 text-left shadow-sm transition hover:border-primary/40 hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-sm font-bold text-white shadow-md">
                  {initialsFor(membership.workspaceName)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-base font-bold">
                    {membership.workspaceName}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {membership.roleName}
                  </span>
                </span>
                <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
              </button>
            ))}
          </div>
        )}
      </div>

      {user.isSuperadmin && (
        <Link
          href="/admin-portal"
          className="hidden absolute bottom-6 left-6 z-10 md:flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground shadow-sm transition hover:border-primary/40 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings className="h-4 w-4" />
          Admin Portal
        </Link>
      )}

      <button
        type="button"
        onClick={() => signOut()}
        className="absolute bottom-6 right-6 z-10 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LogOut className="h-3.5 w-3.5" />
        Sign out
      </button>
    </div>
  );
}
