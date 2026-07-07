'use client';

import { useEffect, useState } from 'react';
import { useParams, usePathname } from 'next/navigation';
import { Check, CircleUser, LogOut } from 'lucide-react';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface Membership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}

function initialsFor(name: string) {
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
 * Mobile (PWA) workspace switcher. Renders a bottom-nav tab that opens a 50vh
 * bottom-sheet listing every workspace the user can access — each row shows the
 * workspace avatar (initials), name, and slug.
 *
 * Mirrors the desktop `WorkspaceSwitcher` in `DashboardLayout`: the current
 * workspace is read from the URL's `workspaceSlug` param (not the session's
 * globally-active id) and switching hard-navigates to the same page under the
 * new slug after syncing the session cookie via `switchWorkspace`.
 */
export function MobileWorkspaceSwitcher({ className }: { className?: string }) {
  const pathname = usePathname();
  const params = useParams<{ workspaceSlug?: string }>();
  const { switchWorkspace, signOut } = useAuth();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [open, setOpen] = useState(false);

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
    try {
      await switchWorkspace(target.workspaceId);
      window.location.assign(pathname.replace(/^\/w\/[^/]+/, `/w/${slug}`));
    } catch {
      toast.error('Could not switch workspace — please try again');
    }
  };

  const handleLogout = async () => {
    setOpen(false);
    try {
      await signOut();
    } catch {
      toast.error('Could not log out — please try again');
    }
  };

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          aria-label="Profile"
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none',
            open && 'text-purple-600 dark:text-purple-400',
            className,
          )}
        >
          <CircleUser className={cn('h-5 w-5', open && 'scale-110')} />
          <span>Profile</span>
        </button>
      </DrawerTrigger>
      <DrawerContent className="h-[50vh]">
        <DrawerHeader className="text-left">
          <DrawerTitle>Switch workspace</DrawerTitle>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto px-2 pb-[env(safe-area-inset-bottom)]">
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
                      onClick={() => handleSelect(m.workspaceSlug)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors',
                        active ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 text-sm font-bold text-white">
                        {initialsFor(m.workspaceName)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn("truncate text-sm font-medium text-foreground",
                          active && 'text-gray-50 dark:text-purple-400'
                        )}>
                          {m.workspaceName}
                        </span>
                        <span className={cn("truncate text-xs text-muted-foreground",
                          active && 'text-gray-200'
                        )}>
                          /{m.workspaceSlug}
                        </span>
                      </span>
                      <Check
                        className={cn(
                          'h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400',
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
        <div className="border-t p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 focus:outline-none"
              >
                <LogOut className="h-4 w-4 shrink-0" />
                Log out
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Log out?</AlertDialogTitle>
                <AlertDialogDescription>
                  You&apos;ll be signed out of your account and returned to the
                  login screen.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleLogout}
                  className="bg-red-600 hover:bg-red-700 focus-visible:ring-red-600"
                >
                  Log out
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
