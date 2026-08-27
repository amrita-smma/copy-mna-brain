'use client';

import { usePathname } from 'next/navigation';
import {
  Circle,
  Database,
  FileStack,
  GitBranch,
  Landmark,
  LayoutDashboard,
  Network,
  Presentation,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
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
  pipeline: GitBranch,
  'fund-management': Landmark,
  'master-data': Database,
  crm: Users,
  'smart-files': FileStack,
  presentation: Presentation,
  'ai-workforce': Sparkles,
  graph: Network,
};

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
  onNavigate,
}: {
  tab: ConsoleTab;
  isActive: boolean;
  iconOnly: boolean;
  onNavigate?: () => void;
}) {
  const { revealConsole } = useLayoutControl();
  // Fall back rather than render `undefined` as a component: a new tab added to
  // the registry without an icon here must not take the whole list down with it.
  const Icon = TAB_ICONS[tab.slug] ?? Circle;

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
        'flex items-center rounded-md text-sm transition-colors',
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
    </WorkspaceLink>
  );

  if (!iconOnly) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{tab.label}</TooltipContent>
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

  if (iconOnly) {
    return (
      <nav aria-label="Pages" className={cn('p-2', className)}>
        <ul className="flex flex-col items-center space-y-1">
          {visibleConsoleTabs(featureFlags).map((tab) => (
            <li key={tab.slug}>
              <PageLink
                tab={tab}
                isActive={tab.slug === activeSlug}
                iconOnly
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label="Pages" className={cn('flex flex-col gap-1', className)}>
      {groupedConsoleTabs(featureFlags).map((group) => (
        <SidebarCollapsibleSection key={group.id} id={group.id} label={group.label}>
          <ul className="space-y-0.5">
            {group.tabs.map((tab) => (
              <li key={tab.slug}>
                <PageLink
                  tab={tab}
                  isActive={tab.slug === activeSlug}
                  iconOnly={false}
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
