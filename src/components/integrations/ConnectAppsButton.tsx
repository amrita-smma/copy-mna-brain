'use client';

import { Plug } from 'lucide-react';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidebar } from '@/components/ui/sidebar';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
import { GmailIcon, GoogleCalendarIcon, GoogleDriveIcon } from './AppIcons';

/** Profile → Connected apps. */
export const CONNECTED_APPS_HREF = '/profile?tab=apps';

/**
 * The sidebar footer's "Connect Apps" entry, above the name / tasks / bell row.
 * A link (middle-clickable, prefetched) to Profile → Connected apps, where
 * Meeting Intelligence and Gmail connect today and Drive, Calendar and the rest
 * are listed as coming soon. The overlapping Gmail / Drive / Calendar marks say
 * what "apps" means at a glance. At icon width it shrinks to a plug with a
 * tooltip.
 */
export function ConnectAppsButton() {
  // The copilot may be full-screen over the console; dock it so the page
  // opens in view (same as the Profile link in the account menu).
  const { revealConsole } = useLayoutControl();
  const { state } = useSidebar();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <WorkspaceLink
          href={CONNECTED_APPS_HREF}
          onClick={revealConsole}
          data-testid="sidebar-connect-apps"
          aria-label="Connect Apps"
          className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-card px-3 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent group-data-[state=collapsed]:h-8 group-data-[state=collapsed]:w-8 group-data-[state=collapsed]:justify-center group-data-[state=collapsed]:p-0"
        >
          <Plug className="h-4 w-4 shrink-0 text-sidebar-foreground/70" />
          <span className="flex-1 truncate group-data-[state=collapsed]:hidden">Connect Apps</span>
          <span className="flex shrink-0 items-center -space-x-1.5 group-data-[state=collapsed]:hidden">
            {[GmailIcon, GoogleDriveIcon, GoogleCalendarIcon].map((Icon, i) => (
              <span
                key={i}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-sidebar-border bg-card"
              >
                <Icon className="h-3 w-3" />
              </span>
            ))}
          </span>
        </WorkspaceLink>
      </TooltipTrigger>
      {/* Only needed when the label is hidden at icon width. */}
      {state === 'collapsed' && <TooltipContent side="right">Connect Apps</TooltipContent>}
    </Tooltip>
  );
}
