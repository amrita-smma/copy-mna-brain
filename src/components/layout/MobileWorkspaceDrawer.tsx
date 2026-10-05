'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useParams, usePathname } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';

export interface Membership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}

export function workspaceInitials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join('') || '?'
  );
}

/**
 * Mobile (PWA) workspace switcher sheet. Opened from the workspace dropdown
 * under the user's name on the profile page — the bottom nav's Profile tab is
 * a link to that page, not a trigger for this.
 *
 * `trigger` is rendered as the drawer's trigger (it must forward a ref and
 * accept the trigger props — any DOM element or `asChild`-friendly component
 * does). `renderTrigger` gets the resolved current workspace so the trigger
 * can show its name without fetching the membership list a second time.
 *
 * Mirrors the desktop `WorkspaceSwitcher` in `AppShell`: the current workspace
 * is read from the URL's `workspaceSlug` param (not the session's globally
 * active id) and switching hard-navigates to the same page under the new slug
 * after syncing the session cookie via `switchWorkspace`.
 */
export function MobileWorkspaceDrawer({
  renderTrigger,
}: {
  renderTrigger: (state: {
    current: Membership | null;
    loading: boolean;
  }) => ReactNode;
}) {
  const pathname = usePathname();
  const params = useParams<{ workspaceSlug?: string }>();
  const { switchWorkspace } = useAuth();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [open, setOpen] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workspaces');
        if (!res.ok) return;
        const { data } = await res.json();
        if (!cancelled) setMemberships(data ?? []);
      } catch {
        if (!cancelled) setMemberships([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentSlug = params.workspaceSlug;
  const current =
    memberships?.find((m) => m.workspaceSlug === currentSlug) ?? memberships?.[0];

  const handleSelect = async (slug: string) => {
    setOpen(false);
    if (slug === currentSlug) return;
    const target = memberships?.find((m) => m.workspaceSlug === slug);
    if (!target) return;
    setIsNavigating(true);
    try {
      await switchWorkspace(target.workspaceId);
      window.location.assign(pathname.replace(/^\/w\/[^/]+/, `/w/${slug}`));
    } catch {
      setIsNavigating(false);
      toast.error('Could not switch workspace — please try again');
    }
  };

  return (
    <>
      {isNavigating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          {renderTrigger({ current: current ?? null, loading: memberships === null })}
        </DrawerTrigger>
        <DrawerContent className="h-[50vh]">
          <DrawerHeader className="text-left">
            <DrawerTitle>Switch workspace</DrawerTitle>
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            {!memberships ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">Loading…</p>
            ) : memberships.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                No workspaces available.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {memberships.map((m) => {
                  const active = m.workspaceSlug === current?.workspaceSlug;
                  return (
                    <li key={m.workspaceId}>
                      <button
                        type="button"
                        data-testid={`mobile-workspace-option-${m.workspaceSlug}`}
                        onClick={() => handleSelect(m.workspaceSlug)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors',
                          active ? 'bg-accent' : 'hover:bg-accent/60',
                        )}
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 text-sm font-bold text-white">
                          {workspaceInitials(m.workspaceName)}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span
                            className={cn(
                              'truncate text-sm font-medium text-foreground',
                              active && 'text-gray-50 dark:text-blue-400',
                            )}
                          >
                            {m.workspaceName}
                          </span>
                          <span
                            className={cn(
                              'truncate text-xs text-muted-foreground',
                              active && 'text-gray-200',
                            )}
                          >
                            /{m.workspaceSlug}
                          </span>
                        </span>
                        <Check
                          className={cn(
                            'h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400',
                            active ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
