'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { InsightListItem, InsightListQuery } from '@/lib/insights/types';
import { formatInsightDate } from '@/lib/insights/format';
import { describeInsightAgent } from '@/lib/insights/agentLabel';
import { INSIGHT_LIST_GENERAL_AGENT } from '@/lib/insights/listQuery';
import { describeRoutinePause } from '@/lib/routines/pauseReason';
import { listSectorAgents } from '@/lib/agents/sector/registry';
import {
  duplicateInsight,
  featureInsight,
  getInsightHtml,
  listInsights,
  restoreInsight,
} from '@/lib/api/insights';
import { createLruCache } from '@/lib/insights/lruCache';
import { useWorkspaceHref, useWorkspacePush } from '@/hooks/useWorkspaceHref';
import { InsightEmptyState } from './InsightEmptyState';
import { InsightManageDialog } from './InsightManageDialog';
import { InsightTemplateList } from './InsightTemplateList';
import { HtmlHoverPreview } from './HtmlHoverPreview';
import { INSIGHT_FEATURED_HELP } from './featuredHelp';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  CalendarClock,
  Copy,
  FileCode2,
  Loader2,
  MoreVertical,
  Pencil,
  Search,
  SearchX,
  Star,
  StarOff,
  Trash2,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// Module-level: shared across remounts of this component within the tab,
// bounded so a long scroll through the list can't grow it unbounded.
const insightPreviewCache = createLruCache(24);

/** Rows fetched per request; "Load more" asks for the next page. */
const PAGE_SIZE = 50;
/** How long the search box waits after the last keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 300;
/** The agent filter's "no filter" value — Radix Select refuses `''`. */
const ALL_AGENTS = 'all';

/** The bound sector agent's handle on a list card; nothing when unbound. */
function InsightListAgentTag({
  insightId,
  agentKey,
}: {
  insightId: string;
  agentKey: string | null;
}) {
  const agent = describeInsightAgent(agentKey);
  if (!agent) return null;
  return (
    <span
      className="text-[10px] font-mono text-muted-foreground"
      title={[agent.sector, agent.deprecated ? 'deprecated' : null]
        .filter(Boolean)
        .join(' · ')}
      data-testid={`insight-list-agent-${insightId}`}
    >
      {agent.handle}
      {agent.deprecated && ' (deprecated)'}
    </span>
  );
}

/**
 * The refresh schedule's state on a list card: "Scheduled" while it runs,
 * "Refresh paused" when the system paused it for a broken binding (MB-560).
 * Nothing without a schedule, or for one switched off by hand.
 */
function InsightListRefreshBadge({ insight }: { insight: InsightListItem }) {
  const { refresh } = insight;
  if (!refresh) return null;
  if (refresh.enabled) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground"
        data-testid={`insight-list-refresh-${insight.id}`}
      >
        <CalendarClock className="h-3 w-3" />
        Scheduled
      </span>
    );
  }
  if (!refresh.paused_reason) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-amber-300 dark:border-amber-800 bg-card px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
      title={describeRoutinePause(refresh.paused_reason, insight.agent_key) ?? refresh.paused_reason}
      data-testid={`insight-list-refresh-paused-${insight.id}`}
    >
      <CalendarClock className="h-3 w-3" />
      Refresh paused
    </span>
  );
}

export type InsightListTab = 'insights' | 'templates';

export interface InsightListProps {
  onNewInsight: () => void;
  onUseTemplate: (tpl: { id: string; name: string }) => void;
  /** The tab open on arrival, from the `?tab=` query, e.g. "View templates". */
  initialTab?: InsightListTab;
}

export function InsightList({
  onNewInsight,
  onUseTemplate,
  initialTab = 'insights',
}: InsightListProps) {
  const push = useWorkspacePush();
  const router = useRouter();
  const listHref = useWorkspaceHref('/insight/list');

  // The open tab is state, kept in the URL (`?tab=templates`; the default is
  // left out) so a refresh or back lands on it. A new `initialTab` — a "View
  // templates" link followed while the list is on screen, or back — re-opens
  // that tab. Tabs are not keyed on it, and the search and filters live here
  // above them, so a tab change never resets them.
  const [tab, setTab] = useState<InsightListTab>(initialTab);
  const [arrivalTab, setArrivalTab] = useState<InsightListTab>(initialTab);
  if (initialTab !== arrivalTab) {
    setArrivalTab(initialTab);
    setTab(initialTab);
  }
  const handleTabChange = (value: string) => {
    const next: InsightListTab = value === 'templates' ? 'templates' : 'insights';
    setTab(next);
    router.replace(next === 'templates' ? `${listHref}?tab=templates` : listHref, {
      scroll: false,
    });
  };

  // ── Search, filters and the loaded pages ──
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [agent, setAgent] = useState<string>(ALL_AGENTS);
  const [mine, setMine] = useState(false);
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    const next = searchInput.trim();
    const timer = setTimeout(() => setSearch(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo<InsightListQuery>(
    () => ({
      q: search || undefined,
      agent: agent === ALL_AGENTS ? undefined : agent,
      mine,
      archived,
    }),
    [search, agent, mine, archived],
  );
  const filtered = Boolean(search) || agent !== ALL_AGENTS || mine;

  const [items, setItems] = useState<InsightListItem[]>([]);
  const [total, setTotal] = useState(0);
  // Which view the loaded rows came from: until a switch to Archived (or
  // back) answers, the rows on screen are still the other view's, and must
  // keep that view's row actions.
  const [itemsArchived, setItemsArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // Bumped by every first-page load; a response for an older one is dropped,
  // so a slow request can't overwrite the rows of a newer search.
  const requestSeqRef = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const page = await listInsights({ ...query, limit: PAGE_SIZE, offset: 0 });
      if (seq !== requestSeqRef.current) return;
      setItems(page.items);
      setTotal(page.total);
      setItemsArchived(query.archived === true);
      setListError(null);
    } catch (err: unknown) {
      if (seq !== requestSeqRef.current) return;
      console.error('Failed to list insights', err);
      setListError(err instanceof Error ? err.message : 'Failed to load insights');
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [query]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const handleLoadMore = async () => {
    if (loadingMore || loading) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    try {
      const page = await listInsights({ ...query, limit: PAGE_SIZE, offset: items.length });
      if (seq !== requestSeqRef.current) return;
      // A row that moved between pages since the first one loaded (e.g. an
      // edit bumped it) would otherwise show twice.
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setTotal(page.total);
    } catch (err: unknown) {
      if (seq !== requestSeqRef.current) return;
      console.error('Failed to load more insights', err);
      toast.error(err instanceof Error ? err.message : 'Failed to load more insights');
    } finally {
      if (seq === requestSeqRef.current) setLoadingMore(false);
    }
  };

  // After a change to a row, start again from the first page: the change may
  // move rows between pages or out of the filter altogether.
  const onChanged = () => {
    void loadFirstPage();
  };

  const clearFilters = () => {
    setSearchInput('');
    setSearch('');
    setAgent(ALL_AGENTS);
    setMine(false);
  };

  const agentOptions = useMemo(() => listSectorAgents({ includeDeprecated: true }), []);

  // ── Row actions ──
  const [manageState, setManageState] = useState<{
    insight: InsightListItem;
    mode: 'rename' | 'archive' | 'delete';
  } | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [featuringId, setFeaturingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const handleDuplicate = async (id: string) => {
    if (duplicatingId) return;
    setDuplicatingId(id);
    try {
      await duplicateInsight(id);
      toast.success('Insight duplicated');
      onChanged();
    } catch (err: unknown) {
      console.error('Failed to duplicate insight', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to duplicate insight',
      );
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleToggleFeatured = async (insight: InsightListItem) => {
    if (featuringId) return;
    const nextFeatured = !insight.is_featured;
    setFeaturingId(insight.id);
    try {
      await featureInsight(insight.id, nextFeatured);
      toast.success(nextFeatured ? 'Set as featured' : 'Removed as featured');
      onChanged();
    } catch (err: unknown) {
      console.error('Failed to update featured status', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to update featured status',
      );
    } finally {
      setFeaturingId(null);
    }
  };

  const handleRestore = async (insight: InsightListItem) => {
    if (restoringId) return;
    setRestoringId(insight.id);
    try {
      await restoreInsight(insight.id);
      toast.success(`Restored "${insight.name}"`);
      onChanged();
    } catch (err: unknown) {
      console.error('Failed to restore insight', err);
      toast.error(err instanceof Error ? err.message : 'Failed to restore insight');
    } finally {
      setRestoringId(null);
    }
  };

  const renderBody = () => {
    if (loading && items.length === 0) {
      return (
        <div className="flex items-center justify-center p-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="ml-3 text-sm text-muted-foreground">Loading insights...</span>
        </div>
      );
    }

    if (listError && items.length === 0) {
      return (
        <div className="p-8 rounded-lg border border-destructive bg-card text-destructive flex items-center gap-3">
          <AlertCircle className="h-6 w-6 shrink-0" />
          <div className="flex-1">
            <h3 className="font-semibold text-base">Unable to load insights</h3>
            <p className="text-sm">{listError}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadFirstPage()}>
            Retry
          </Button>
        </div>
      );
    }

    if (total === 0 && items.length === 0) {
      if (filtered) {
        return (
          <InsightEmptyState
            onNewInsight={clearFilters}
            title="No matching insights"
            body={
              itemsArchived
                ? 'No archived insight matches this search and these filters.'
                : 'No insight matches this search and these filters.'
            }
            actionLabel="Clear filters"
            icon={SearchX}
            actionIcon={SearchX}
          />
        );
      }
      if (itemsArchived) {
        return (
          <InsightEmptyState
            onNewInsight={() => setArchived(false)}
            title="No archived insights"
            body="Archived insights appear here, where they can be restored or deleted permanently."
            actionLabel="Show active insights"
            icon={Archive}
            actionIcon={FileCode2}
          />
        );
      }
      return <InsightEmptyState onNewInsight={onNewInsight} />;
    }

    return (
      <>
        <div className="flex items-baseline gap-2 mb-4">
          <h1 className="text-lg font-semibold text-foreground">
            {itemsArchived ? 'Archived insights' : 'All insights'}
          </h1>
          <span className="text-xs text-muted-foreground" data-testid="insight-list-total">
            {total} {total === 1 ? 'insight' : 'insights'}
          </span>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>

        <ul className="space-y-2" data-testid="insight-list">
          {items.map((insight) =>
            itemsArchived ? (
              // An archived insight can't be opened or previewed (both read
              // it as missing), so its row is inert: restore or delete only.
              <li
                key={insight.id}
                className="rounded-xl border border-border bg-card shadow-sm flex items-center justify-between gap-4 p-4"
                data-testid={`insight-list-archived-item-${insight.id}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {insight.name}
                    </span>
                    {insight.description ? (
                      <p className="text-xs text-muted-foreground line-clamp-1">
                        {insight.description}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <InsightListAgentTag insightId={insight.id} agentKey={insight.agent_key} />
                  <span className="text-xs text-muted-foreground">
                    Updated {formatInsightDate(insight.updated_at)}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRestore(insight)}
                    disabled={restoringId === insight.id}
                    className="h-8 gap-1.5 bg-card hover:bg-muted text-foreground border-border"
                    data-testid={`insight-list-restore-${insight.id}`}
                  >
                    {restoringId === insight.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArchiveRestore className="h-4 w-4" />
                    )}
                    Restore
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setManageState({ insight, mode: 'delete' })}
                    className="h-8 gap-1.5 bg-card hover:bg-muted text-destructive border-border"
                    data-testid={`insight-list-delete-permanently-${insight.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete permanently
                  </Button>
                </div>
              </li>
            ) : (
              <HtmlHoverPreview
                key={insight.id}
                id={insight.id}
                // A publish/rollback/refresh bumps the version; keying on it
                // keeps the tab-lifetime cache from serving the old HTML.
                cacheKey={`${insight.id}:${insight.latest_version_no}`}
                title={insight.name}
                fetchHtml={getInsightHtml}
                cache={insightPreviewCache}
              >
                <li className="rounded-xl border border-border bg-card shadow-sm flex items-center justify-between">
                  <button
                    type="button"
                    data-testid={`insight-list-item-${insight.id}`}
                    onClick={() => push(`/insight/${insight.id}`)}
                    className="flex-1 min-w-0 text-left p-4 hover:bg-muted transition-colors rounded-l-xl flex items-center justify-between gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-foreground">
                            {insight.name}
                          </span>
                          {insight.is_featured && (
                            <span
                              title={INSIGHT_FEATURED_HELP}
                              className="inline-flex shrink-0"
                              data-testid={`insight-list-featured-${insight.id}`}
                            >
                              <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
                              <span className="sr-only">Featured. {INSIGHT_FEATURED_HELP}</span>
                            </span>
                          )}
                        </div>
                        {insight.description ? (
                          <p className="text-xs text-muted-foreground line-clamp-1">
                            {insight.description}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <InsightListRefreshBadge insight={insight} />
                      <InsightListAgentTag insightId={insight.id} agentKey={insight.agent_key} />
                      <span className="text-[10px] font-mono text-muted-foreground">
                        v{insight.latest_version_no}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Updated {formatInsightDate(insight.updated_at)}
                      </span>
                      {insight.created_by_name && (
                        <span className="text-xs text-muted-foreground">
                          by {insight.created_by_name}
                        </span>
                      )}
                    </div>
                  </button>

                  <div className="shrink-0 pr-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0 bg-card hover:bg-muted text-foreground border-border"
                          data-testid={`insight-list-menu-${insight.id}`}
                        >
                          <span className="sr-only">Insight options</span>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-card text-foreground border border-border shadow-md"
                      >
                        <DropdownMenuItem
                          onClick={() => setManageState({ insight, mode: 'rename' })}
                          className="cursor-pointer hover:bg-muted focus:bg-muted"
                        >
                          <Pencil className="h-4 w-4 mr-2 text-muted-foreground" />
                          Rename…
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDuplicate(insight.id)}
                          disabled={duplicatingId === insight.id}
                          className="cursor-pointer hover:bg-muted focus:bg-muted"
                        >
                          <Copy className="h-4 w-4 mr-2 text-muted-foreground" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleToggleFeatured(insight)}
                          disabled={featuringId === insight.id}
                          title={INSIGHT_FEATURED_HELP}
                          className="cursor-pointer hover:bg-muted focus:bg-muted"
                        >
                          {insight.is_featured ? (
                            <>
                              <StarOff className="h-4 w-4 mr-2 text-muted-foreground" />
                              Remove as featured
                            </>
                          ) : (
                            <>
                              <Star className="h-4 w-4 mr-2 text-muted-foreground" />
                              Set as featured
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          onClick={() => setManageState({ insight, mode: 'archive' })}
                          className="cursor-pointer text-destructive focus:text-destructive hover:bg-muted focus:bg-muted"
                        >
                          <Archive className="h-4 w-4 mr-2 text-destructive" />
                          Archive…
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setManageState({ insight, mode: 'delete' })}
                          className="cursor-pointer text-destructive focus:text-destructive hover:bg-muted focus:bg-muted"
                        >
                          <Trash2 className="h-4 w-4 mr-2 text-destructive" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              </HtmlHoverPreview>
            ),
          )}
        </ul>

        {items.length < total && (
          <div className="flex justify-center mt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleLoadMore()}
              disabled={loadingMore}
              className="h-8 gap-1.5 bg-card hover:bg-muted text-foreground border-border"
              data-testid="insight-list-load-more"
            >
              {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
              Load more ({total - items.length} more)
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Tabs value={tab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="insights">Insight List</TabsTrigger>
          <TabsTrigger value="templates">Template List</TabsTrigger>
        </TabsList>

        <TabsContent value="insights">
          {/* ── Controls: always shown, so a filter that matches nothing can be undone ── */}
          <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="insight-list-controls">
            <div
              className="inline-flex rounded-md border border-border bg-card p-0.5"
              role="group"
              aria-label="Show active or archived insights"
            >
              {([
                ['active', 'Active'],
                ['archived', 'Archived'],
              ] as const).map(([value, label]) => {
                const selected = (value === 'archived') === archived;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setArchived(value === 'archived')}
                    className={cn(
                      'h-7 rounded px-3 text-xs font-medium transition-colors',
                      selected
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    data-testid={`insight-list-view-${value}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="relative flex-1 min-w-[12rem]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search name or description"
                aria-label="Search insights"
                className="h-8 pl-8 bg-card"
                data-testid="insight-list-search"
              />
            </div>

            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger
                className="h-8 w-48 bg-card text-xs"
                aria-label="Filter by agent"
                data-testid="insight-list-agent-filter"
              >
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent className="bg-card">
                <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
                <SelectItem value={INSIGHT_LIST_GENERAL_AGENT}>General CoPilot</SelectItem>
                {agentOptions.map((a) => (
                  <SelectItem key={a.key} value={a.key}>
                    {a.handle} · {a.name}
                    {a.deprecated ? ' (deprecated)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={mine}
              onClick={() => setMine((on) => !on)}
              className={cn(
                'h-8 gap-1.5 border-border',
                mine ? 'bg-muted text-primary' : 'bg-card hover:bg-muted text-foreground',
              )}
              data-testid="insight-list-mine"
            >
              <UserRound className="h-4 w-4" />
              Created by me
            </Button>
          </div>

          {renderBody()}
        </TabsContent>

        <TabsContent value="templates">
          <InsightTemplateList onUseTemplate={onUseTemplate} />
        </TabsContent>
      </Tabs>

      {manageState && (
        <InsightManageDialog
          insightId={manageState.insight.id}
          insightName={manageState.insight.name}
          mode={manageState.mode}
          open={true}
          onOpenChange={(open) => {
            if (!open) setManageState(null);
          }}
          onDone={() => {
            setManageState(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
