'use client';

import { usePathname } from 'next/navigation';
import {
  Circle,
  Database,
  FileCode2,
  FileStack,
  GitBranch,
  Radar,
  Landmark,
  LayoutDashboard,
  Network,
  Presentation,
  Receipt,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useSourcingPendingCount } from '@/hooks/useSourcingPendingCount';
import {
  findTabByPath,
  groupedConsoleTabs,
  toLogicalPath,
  visibleConsoleTabs,
  type ConsoleTab,
} from '@/lib/navigation/consoleTabs';
import { useFeatureFlags } from './FeatureFlagsContext';
import { useLayoutControl } from './LayoutControlContext';
import { SidebarCollapsibleSection } from './SidebarCollapsibleSection';

/**
 * Icons live here rather than in the tab registry: that module is imported by
 * the copilot's `navigate_page` tool, and an agent tool must not pull
 * `lucide-react` into its bundle.
 */
const TAB_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  sourcing: Radar,
  pipeline: GitBranch,
  'fund-management': Landmark,
  ledger: Receipt,
  'master-data': Database,
  crm: Users,
  insight: FileCode2,
  'smart-files': FileStack,
  presentation: Presentation,
  'ai-workforce': Sparkles,
  graph: Network,
};

/** Caps a badge count so a large backlog can't stretch the nav row. */
function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * Per-slug attention counts shown as a red badge on the nav item — today just
 * Sourcing's Pending Confirmation backlog. Fetched only while Sourcing is in the
 * nav, so a workspace with the pipeline flagged off makes no request.
 */
function useNavBadgeCounts(tabs: ConsoleTab[]): Record<string, number> {
  const pending = useSourcingPendingCount(tabs.some((tab) => tab.slug === 'sourcing'));
  return { sourcing: pending };
}

/**
 * One nav destination. Each entry is a real `<WorkspaceLink>`, so switching is a
 * Next.js soft navigation: the shell around it stays mounted and only the
 * console's contents change. That is what keeps the chat pane and its in-flight
 * stream alive across a page switch.
 */
function PageLink({
  tab,
  isActive,
  iconOnly,
  badgeCount = 0,
  onNavigate,
}: {
  tab: ConsoleTab;
  isActive: boolean;
  iconOnly: boolean;
  /** Items needing attention; a red badge is shown when above zero. */
  badgeCount?: number;
  onNavigate?: () => void;
}) {
  const { revealConsole } = useLayoutControl();
  // Fall back rather than render `undefined` as a component: a new tab added to
  // the registry without an icon here must not take the whole list down with it.
  const Icon = TAB_ICONS[tab.slug] ?? Circle;
  const badge = badgeCount > 0 ? formatBadgeCount(badgeCount) : null;
  const badgeLabel = badge ? `${badgeCount} pending` : null;

  const link = (
    <WorkspaceLink
      href={tab.path}
      aria-current={isActive ? 'page' : undefined}
      // The copilot may be sitting full-screen over the console — navigating
      // behind it would swap the page out of sight and the click would look
      // like it did nothing.
      onClick={() => {
        revealConsole();
        onNavigate?.();
      }}
      className={cn(
        'relative flex items-center rounded-md text-sm transition-colors',
        iconOnly ? 'h-8 w-8 justify-center' : 'w-full gap-2 px-3 py-1.5',
        isActive
          ? 'bg-blue-500/10 font-medium text-blue-700 dark:text-blue-300'
          : 'text-foreground/80 hover:bg-muted',
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0 opacity-70" />
      {/* Kept in the DOM when collapsed so the link still has an accessible
          name — the tooltip alone would not give it one. */}
      <span className={cn('min-w-0 flex-1 truncate', iconOnly && 'sr-only')}>{tab.label}</span>
      {badge &&
        (iconOnly ? (
          <>
            {/* No room for a count on the rail — a dot on the icon's corner
                flags it, and the count goes to screen readers and the tooltip. */}
            <span
              data-testid={`nav-badge-${tab.slug}`}
              aria-hidden="true"
              className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-600 ring-2 ring-sidebar"
            />
            <span className="sr-only">{badgeLabel}</span>
          </>
        ) : (
          <span
            data-testid={`nav-badge-${tab.slug}`}
            aria-label={badgeLabel ?? undefined}
            className="ml-auto flex-shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold leading-none text-white tabular-nums"
          >
            {badge}
          </span>
        ))}
    </WorkspaceLink>
  );

  if (!iconOnly) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {tab.label}
        {badgeLabel && ` · ${badgeLabel}`}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The app's destination list, rendered as collapsible sections in the sidebar
 * ("Deal Flow", "Intelligence") above the chat history.
 *
 * This started as a strip of icon tabs across the top of the center console,
 * then became a History/Pages tab strip inside the sidebar. Both made pages and
 * chats mutually exclusive — you could only ever see one. Sections show
 * everything at once; see {@link SidebarCollapsibleSection}.
 */
export function SidebarPagesNav({
  className,
  onNavigate,
  iconOnly = false,
}: {
  className?: string;
  /** Called after a page is chosen — lets the mobile drawer close itself. */
  onNavigate?: () => void;
  /**
   * Render as a rail of icons with tooltip labels, for the icon-collapsed
   * sidebar. Group headers are dropped there — there is no room for a label —
   * so the rail is one flat list, which is also the only way to reach a page at
   * all while the sidebar is collapsed.
   */
  iconOnly?: boolean;
}) {
  const pathname = usePathname();
  const featureFlags = useFeatureFlags();

  const activeSlug = findTabByPath(toLogicalPath(pathname))?.slug;
  const visibleTabs = visibleConsoleTabs(featureFlags);
  const badgeCounts = useNavBadgeCounts(visibleTabs);

  if (iconOnly) {
    return (
      <nav aria-label="Pages" className={cn('p-2', className)}>
        <ul className="flex flex-col items-center space-y-1">
          {visibleTabs.map((tab) => (
            <li key={tab.slug}>
              <PageLink
                tab={tab}
                isActive={tab.slug === activeSlug}
                iconOnly
                badgeCount={badgeCounts[tab.slug]}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label="Pages" className={cn('flex flex-col gap-4', className)}>
      {groupedConsoleTabs(featureFlags).map((group) => (
        <SidebarCollapsibleSection key={group.id} id={group.id} label={group.label}>
          <ul className="space-y-0.5">
            {group.tabs.map((tab) => (
              <li key={tab.slug}>
                <PageLink
                  tab={tab}
                  isActive={tab.slug === activeSlug}
                  iconOnly={false}
                  badgeCount={badgeCounts[tab.slug]}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        </SidebarCollapsibleSection>
      ))}
    </nav>
  );
}
