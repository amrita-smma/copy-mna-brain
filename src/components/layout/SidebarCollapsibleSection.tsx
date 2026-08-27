'use client';

import { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { cn } from '@/lib/utils';

/**
 * The persisted open/closed state of one sidebar section.
 *
 * Exported so a caller that needs to *force* a section open — "New Chat" has to
 * reveal Chat History, or the row it just created stays hidden — can own the
 * state and hand it to {@link SidebarCollapsibleSection} as a controlled prop.
 * Two `useLocalStorage` instances on the same key do not sync with each other,
 * so the state has to be lifted rather than read twice.
 */
export function useSidebarSectionOpen(id: string, defaultOpen = true) {
  return useLocalStorage<boolean>(`layout:sidebar-section:${id}`, defaultOpen);
}

/**
 * One labelled, collapsible block in the expanded sidebar — a nav group ("Deal
 * Flow", "Intelligence") or the chat list ("Chat History").
 *
 * This replaced a History/Pages tab strip at the top of the sidebar. Tabs made
 * the two halves of the sidebar mutually exclusive: opening a page meant losing
 * sight of the chat list and vice versa, and neither tab's contents were
 * visible while you were on the other. Sections show everything at once and let
 * the user fold away what they don't use.
 *
 * Open/closed state is per section and persisted, so the sidebar comes back the
 * way it was left. Sections start open — a collapsed-by-default nav hides the
 * app's destinations behind a click.
 */
export function SidebarCollapsibleSection({
  id,
  label,
  children,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  className,
}: {
  /** Stable id — also the localStorage key suffix, so don't rename casually. */
  id: string;
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /**
   * Controlled open state, for a caller that also needs to open the section
   * imperatively (see {@link useSidebarSectionOpen}). Omit to let the section
   * manage and persist its own state.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [ownOpen, setOwnOpen] = useSidebarSectionOpen(id, defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : ownOpen;
  const setOpen = isControlled ? (onOpenChange ?? (() => {})) : setOwnOpen;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('px-2', className)}>
      <CollapsibleTrigger
        data-testid={`sidebar-section-${id}`}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5',
          'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70',
          'transition-colors hover:bg-muted hover:text-foreground',
        )}
      >
        {/* Decorative: Radix puts aria-expanded on the trigger, so the chevron
            would only add noise to the announced name. */}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent
        // Radix measures the content to animate it, exposing the height as
        // --radix-collapsible-content-height (see tailwind.config.ts).
        className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
      >
        <div className="pt-0.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
