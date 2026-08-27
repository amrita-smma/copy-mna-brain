'use client';

import { useEffect, useState } from 'react';
import { usePathname, useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

interface Membership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || '?';
}

/**
 * Sidebar brand subtitle: the current workspace name, clickable to switch
 * when the user belongs to more than one. Lives under the "Investment Brain" title
 * in the sidebar header, matching the original workspace-picker placement.
 *
 * The current value comes from the URL's own `workspaceSlug` param, not the
 * session's globally-active `workspaceId` — two tabs on two different
 * workspaces must each show their own selection, not a shared one. Switching
 * hard-navigates to the same page under the new slug (not `router.push`,
 * matching this shell's existing hard-reload convention) so every
 * client-fetched view remounts scoped to the new workspace; `switchWorkspace`
 * is still called first to keep the session cookie in sync for any
 * not-yet-migrated flat-route reads.
 */
export function WorkspaceSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
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
  const current = memberships?.find((m) => m.workspaceSlug === currentSlug) ?? memberships?.[0];

  // Loading, or a single-membership user — nothing to switch to, so render
  // the name (if known yet) as inert text instead of the dropdown trigger.
  if (!memberships || memberships.length <= 1) {
    return (
      <span className="flex h-full w-full items-center truncate text-left text-base font-medium text-sidebar-foreground/60">
        {current?.workspaceName ?? ' '}
      </span>
    );
  }

  const handleSelect = async (slug: string) => {
    setOpen(false);
    if (slug === currentSlug) return;
    const target = memberships.find((m) => m.workspaceSlug === slug);
    if (!target) return;
    setIsNavigating(true);
    try {
      await switchWorkspace(target.workspaceId);
      window.location.assign(pathname.replace(/^\/w\/[^/]+/, `/w/${slug}`));
    } catch {
      // Popover is already closed and switchWorkspace's session update never
      // landed — without this the user is left on the old workspace with no
      // sign anything went wrong.
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Switch workspace"
            className="flex h-full w-full items-center justify-start gap-1 rounded text-left text-base font-medium text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <span className="min-w-0 flex-1 truncate">{current?.workspaceName}</span>
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-sidebar-foreground/40" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Search workspaces…" />
            <CommandList>
              <CommandEmpty>No workspaces found.</CommandEmpty>
              <CommandGroup>
                {memberships.map((m) => (
                  <CommandItem
                    key={m.workspaceId}
                    value={m.workspaceName}
                    onSelect={() => handleSelect(m.workspaceSlug)}
                    className="gap-2"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-blue-600 text-[10px] font-bold text-white">
                      {initialsFor(m.workspaceName)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {m.workspaceName}
                    </span>
                    <Check
                      className={cn(
                        'h-4 w-4 shrink-0',
                        m.workspaceSlug === current?.workspaceSlug ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push('/workspace');
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              Back to Workspaces
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
