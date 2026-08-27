/**
 * The app's destination list — historically the center console's tab strip,
 * now the sidebar's collapsible nav sections.
 *
 * Single source of truth shared by the UI (`SidebarPagesNav`, which attaches the
 * icons) and the copilot's `navigate_page` tool (which builds its argument enum
 * from these slugs). Keeping both on one registry is what stops the agent from
 * being able to name a page the UI doesn't have, or vice versa.
 *
 * Deliberately free of `lucide-react` (or any other UI import): this module is
 * pulled into the agent's tool bundle, which must stay server-safe.
 */

/**
 * The collapsible sidebar section a tab is filed under.
 *
 * Required on every tab (rather than optional with a fallback) so adding a
 * destination without deciding where it belongs is a type error instead of a
 * page that quietly renders in no section — i.e. is unreachable from the nav.
 */
export type ConsoleTabGroupId = 'deal-flow' | 'intelligence';

/** The sidebar's section headers, in display order. */
export const CONSOLE_TAB_GROUPS: { id: ConsoleTabGroupId; label: string }[] = [
  { id: 'deal-flow', label: 'Deal Flow' },
  { id: 'intelligence', label: 'Intelligence' },
];

export interface ConsoleTab {
  /** Stable slug, also the `navigate_page` tool's argument value. */
  slug: string;
  /** Workspace-relative path, prefixed with the active slug by `useWorkspaceHref`. */
  path: string;
  /** Human label shown on the tab and echoed back to the user by the agent. */
  label: string;
  /** Which collapsible sidebar section lists this tab. */
  group: ConsoleTabGroupId;
  /** Feature key from `@/lib/features/catalog` gating this tab's visibility. */
  flag: string;
  /** One line telling the agent when this page is the right destination. */
  purpose: string;
}

export const CONSOLE_TABS: ConsoleTab[] = [
  {
    slug: 'dashboard',
    path: '/dashboard',
    label: 'Dashboard',
    group: 'deal-flow',
    flag: 'DASHBOARD_ENABLED',
    purpose: 'Overview KPIs and recent activity across the pipeline.',
  },
  {
    slug: 'pipeline',
    path: '/pipeline',
    label: 'Pipeline',
    group: 'deal-flow',
    flag: 'PIPELINE_ENABLED',
    purpose: 'The deal pipeline across screening and diligence stages (L0–L5).',
  },
  {
    slug: 'master-data',
    path: '/master-data',
    label: 'Master Data',
    group: 'deal-flow',
    flag: 'MASTER_DATA_ENABLED',
    purpose: 'The canonical company records and their fields.',
  },
  {
    slug: 'crm',
    path: '/crm',
    label: 'CRM',
    group: 'deal-flow',
    flag: 'CRM_ENABLED',
    purpose: 'Relationships — correspondents, employers, topics and notes.',
  },
  {
    slug: 'fund-management',
    path: '/fund-management',
    label: 'Fund Management',
    group: 'deal-flow',
    flag: 'FUND_MANAGEMENT_ENABLED',
    purpose: 'Funds, their assets/holdings, valuations and transactions.',
  },
  {
    slug: 'smart-files',
    path: '/smart-files',
    label: 'Smart Files',
    group: 'intelligence',
    flag: 'SMART_FILES_ENABLED',
    purpose: 'Uploaded documents and meeting notes with extracted structure.',
  },
  {
    slug: 'presentation',
    path: '/presentation',
    label: 'Presentation',
    group: 'intelligence',
    flag: 'PRESENTATION_ENABLED',
    purpose: 'Generated slide decks and company one-pagers.',
  },
  {
    slug: 'ai-workforce',
    path: '/ai-workforce',
    label: 'AI Workspace',
    group: 'intelligence',
    flag: 'AI_WORKFORCE_ENABLED',
    purpose: 'Queued AI Workforce tasks and their reasoning traces.',
  },
  {
    slug: 'graph',
    path: '/graph',
    label: 'Company Graph',
    group: 'intelligence',
    flag: 'COMPANY_GRAPH_ENABLED',
    purpose: 'The relationship graph between companies, owners and sponsors.',
  },
];

/** Every tab slug, in display order — the `navigate_page` argument domain. */
export const CONSOLE_TAB_SLUGS = CONSOLE_TABS.map((tab) => tab.slug);

/**
 * The tabs a workspace with this flag map may see, in display order.
 *
 * An unknown or unresolved key counts as enabled: a flag the resolver hasn't
 * heard of should never silently hide a destination (and leave the user with no
 * way to reach it). Shared by the sidebar's page list and by `AppShell`'s
 * "which tab do I open when the copilot collapses" decision, so the two can't
 * disagree about what is reachable.
 */
export function visibleConsoleTabs(flags: Record<string, boolean>): ConsoleTab[] {
  return CONSOLE_TABS.filter((tab) => flags[tab.flag] ?? true);
}

/**
 * The visible tabs bucketed into their sidebar sections, in display order.
 *
 * Groups whose every tab is flagged off are dropped rather than rendered empty,
 * so a workspace with (say) no Intelligence features doesn't get a header that
 * expands to nothing.
 */
export function groupedConsoleTabs(
  flags: Record<string, boolean>,
): { id: ConsoleTabGroupId; label: string; tabs: ConsoleTab[] }[] {
  const visible = visibleConsoleTabs(flags);
  return CONSOLE_TAB_GROUPS.map((group) => ({
    ...group,
    tabs: visible.filter((tab) => tab.group === group.id),
  })).filter((group) => group.tabs.length > 0);
}

/** The tab with this slug, or `undefined`. */
export function findTabBySlug(slug: string): ConsoleTab | undefined {
  return CONSOLE_TABS.find((tab) => tab.slug === slug);
}

/**
 * The tab a workspace-relative path belongs to, or `undefined` for paths that
 * aren't a console destination (the chat landing, `/workspace`, …).
 *
 * Sub-routes resolve to their parent tab so a deal detail page
 * (`/pipeline/<id>`) still highlights (and reports as) Pipeline.
 */
export function findTabByPath(path: string): ConsoleTab | undefined {
  // `/companies/<id>` is the same CompanyDetail view as `/pipeline/<id>`, just
  // reached as a company rather than as a deal. Classify it as Pipeline so the
  // tab strip highlights, last-tab memory works, and `read_page_context` does
  // not report "full-screen chat" while a company is on screen.
  if (path === '/companies' || path.startsWith('/companies/')) {
    return findTabBySlug('pipeline');
  }
  return CONSOLE_TABS.find(
    (tab) => path === tab.path || path.startsWith(`${tab.path}/`),
  );
}

/**
 * True only for a tab's own path — `/pipeline`, never `/pipeline/<id>`.
 *
 * Distinct from {@link findTabByPath}, which deliberately resolves sub-routes to
 * their parent tab so a deal detail page still highlights Pipeline. Use this
 * where a path is being *trusted* rather than classified: `navigate_page` only
 * ever emits a tab's own path, so anything else — including a sub-route or a
 * traversal like `/pipeline/../../etc` — must be rejected.
 */
export function isConsoleTabPath(path: string): boolean {
  return CONSOLE_TABS.some((tab) => tab.path === path);
}

/**
 * Strips the `/w/<slug>` prefix a real URL carries, yielding the bare path the
 * tabs above are declared with. Returns `/` for the workspace root.
 */
export function toLogicalPath(pathname: string): string {
  return pathname.replace(/^\/w\/[^/]+/, '') || '/';
}

/** A markdown list of destinations, injected into the `navigate_page` description. */
export function describeConsoleTabs(): string {
  return CONSOLE_TABS.map((tab) => `  - \`${tab.slug}\` — ${tab.label}: ${tab.purpose}`).join('\n');
}
