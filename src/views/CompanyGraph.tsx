'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { waitForJob } from '@/lib/jobs/useJob';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeftRight, Check, ChevronDown, ChevronRight, Combine, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
// d3-force-3d is the force engine bundled with react-force-graph-2d; reusing it
// here keeps our custom forces consistent with the graph's own simulation.
import { forceCollide, forceX, forceY } from 'd3-force-3d';
import CompanyDetailDialog, {
  type CompanyData,
} from '@/components/pipeline/CompanyDetailDialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type {
  GraphData,
  GraphLink,
  GraphNode,
  Ownership,
  RelationType,
} from '@/lib/repositories/companyRelationRepository';
import {
  RELATION_COLORS,
  RELATION_LABELS,
  RELATION_TYPES,
  STAGE_COLOR_BLUE,
  STAGE_COLOR_GREY,
  STAGE_COLOR_YELLOW,
  drawGraphNode,
  endpointId,
  estimateNodeRadius,
  evToDisplaySize,
  getNodeRadius,
  hexToRgbTriplet,
  nodeColor,
  nodeDisplaySize,
  nodeSizeFactor,
  neighborIds,
  paintNodePointerArea,
  primaryRelationByNode,
  relationColor,
} from '@/lib/graph/nodeStyle';
import {
  GRAPH_FILTER_PARAMS,
  NO_RELATION,
  NO_STAGE,
  decodeGraphFilters,
  encodeGraphFilters,
  type RelationFilter,
} from '@/lib/graph/graphFilterParams';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import { usePipelineStages } from '@/hooks/usePipelineStages';
import { STAGE_LABELS } from '@/lib/constants';

function NodeCombobox({
  nodes,
  value,
  onChange,
  placeholder = 'Select company…',
}: {
  nodes: GraphNode[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = nodes.find((n) => n.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full h-8 text-xs justify-between font-normal truncate">
          <span className="truncate">{selected ? selected.name : placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search company…" className="h-8 text-xs" />
          <CommandList>
            <CommandEmpty className="text-xs py-4 text-center text-muted-foreground">No company found.</CommandEmpty>
            <CommandGroup>
              {nodes.map((n) => (
                <CommandItem
                  key={n.id}
                  value={n.name}
                  onSelect={() => {
                    onChange(n.id);
                    setOpen(false);
                  }}
                  className="text-xs"
                >
                  <Check className={`mr-2 h-3 w-3 ${value === n.id ? 'opacity-100' : 'opacity-0'}`} />
                  {n.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Multi-select company picker for the "Combine companies" section: a searchable
// checklist that shows each company's pipeline stage alongside its name.
function CompanyMultiSelect({
  nodes,
  selected,
  onToggle,
  placeholder = 'Select companies…',
}: {
  nodes: GraphNode[];
  selected: string[];
  onToggle: (id: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const { code: stageCode } = usePipelineStages();
  const label =
    selected.length === 0
      ? placeholder
      : `${selected.length} compan${selected.length === 1 ? 'y' : 'ies'} selected`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full h-8 text-xs justify-between font-normal truncate">
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search company…" className="h-8 text-xs" />
          <CommandList>
            <CommandEmpty className="text-xs py-4 text-center text-muted-foreground">No company found.</CommandEmpty>
            <CommandGroup>
              {nodes.map((n) => (
                <CommandItem
                  key={n.id}
                  value={n.name}
                  onSelect={() => onToggle(n.id)}
                  className="text-xs"
                >
                  <Check className={`mr-2 h-3 w-3 shrink-0 ${selected.includes(n.id) ? 'opacity-100' : 'opacity-0'}`} />
                  <span className="truncate">{n.name}</span>
                  <span className="ml-auto pl-2 text-[10px] text-muted-foreground shrink-0">
                    {pipelineStageLabel(n.pipelineStage ?? NO_STAGE, stageCode)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Multi-select combobox for "highlighting" companies. Selecting companies
// pins the graph to just those companies and the relationships between them.
// Unlike NodeCombobox, the popover stays open across selections so several
// companies can be toggled in one go, and selected companies show as removable
// chips beneath the trigger.
function NodeMultiCombobox({
  nodes,
  selected,
  onToggle,
  onClear,
  placeholder = 'Highlight companies…',
}: {
  nodes: GraphNode[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedNodes = nodes.filter((n) => selected.has(n.id));
  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" className="w-full h-8 text-xs justify-between font-normal">
            <span className="truncate">
              {selected.size > 0 ? `${selected.size} highlighted` : placeholder}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search company…" className="h-8 text-xs" />
            <CommandList>
              <CommandEmpty className="text-xs py-4 text-center text-muted-foreground">No company found.</CommandEmpty>
              <CommandGroup>
                {nodes.map((n) => (
                  <CommandItem
                    key={n.id}
                    value={n.name}
                    onSelect={() => onToggle(n.id)}
                    className="text-xs"
                  >
                    <Check className={`mr-2 h-3 w-3 ${selected.has(n.id) ? 'opacity-100' : 'opacity-0'}`} />
                    {n.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selectedNodes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {selectedNodes.map((n) => (
            <span
              key={n.id}
              className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-900"
            >
              <span className="max-w-[8rem] truncate">{n.name}</span>
              <button
                type="button"
                aria-label={`Remove ${n.name}`}
                className="text-blue-500 hover:text-blue-900"
                onClick={() => onToggle(n.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline hover:text-foreground"
            onClick={onClear}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

// Toggle `value` in/out of a Set, returning a fresh Set (never mutates `prev`)
// so React state updates are detected. Shared by every multi-select filter.
function toggledSet<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// A generic multi-select dropdown for the company filters. An empty selection
// means "no filter" (show everything), signalled by `allLabel` on the trigger.
// Options can be searched when `searchPlaceholder` is provided (useful for long
// lists like geographies or sectors).
function MultiSelectFilter({
  options,
  selected,
  onToggle,
  onClear,
  allLabel,
  searchPlaceholder,
}: {
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
  allLabel: string;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerLabel =
    selected.size === 0
      ? allLabel
      : selected.size === 1
        ? (options.find((o) => o.value === [...selected][0])?.label ?? '1 selected')
        : `${selected.size} selected`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full h-8 text-sm justify-between font-normal">
          <span className="truncate">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          {searchPlaceholder && (
            <CommandInput
              placeholder={searchPlaceholder}
              className="h-8 text-xs"
              // Reset the scroll box to the top on every keystroke so the best
              // matches (which cmdk re-sorts to the top) are always in view.
              onValueChange={() => {
                if (listRef.current) listRef.current.scrollTop = 0;
              }}
            />
          )}
          <CommandList ref={listRef}>
            <CommandEmpty className="text-xs py-4 text-center text-muted-foreground">No results.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => onToggle(o.value)}
                  className="text-xs"
                >
                  <Check
                    className={`mr-2 h-3.5 w-3.5 shrink-0 ${selected.has(o.value) ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {selected.size > 0 && (
            <div className="border-t p-1">
              <button
                type="button"
                className="w-full rounded-sm py-1.5 text-center text-[11px] text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                onClick={onClear}
              >
                Clear selection
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// `NO_RELATION` (companies with no relationships) and `NO_STAGE` (companies with
// no pipeline stage on the graph node) are the filter-panel sentinels, shared
// with the URL codec in `@/lib/graph/graphFilterParams`.
const NO_RELATION_COLOR = '#94a3b8';
const NO_RELATION_LABEL = 'No relationship';

/** A node's stage for the filter and tooltip: a bucket by name, a workspace stage by its code. */
function pipelineStageLabel(stage: string, code: (key: string) => string): string {
  if (stage === NO_STAGE) return 'No stage';
  return STAGE_LABELS[stage] ?? code(stage);
}

// Lifecycle-status filter options. An empty selection shows both.
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'dropped', label: 'Dropped' },
];

// Ownership filter options. An empty selection shows all.
const OWNERSHIP_OPTIONS: { value: Ownership; label: string }[] = [
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
];

// ─── Connection pathfinding ───────────────────────────────────────────────────
// Maximum path length when tracing connections between highlighted companies,
// mirroring the Neo4j `MATCH path = (a)-[*1..5]-(b)` traversal.
const MAX_PATH_DEPTH = 5;
// Maximum number of alternative paths surfaced per pair (mirrors `LIMIT 5`).
const MAX_PATHS_PER_PAIR = 5;
// Safety valve on the enumeration so a dense graph can't stall the UI thread.
const PATH_EXPLORE_CAP = 20000;

/** A single traversed edge on a connection path (directed from → to along the walk). */
interface PathHop {
  fromId: string;
  toId: string;
  label: RelationType;
  key: string;
}

/** The connection paths between a unique pair of highlighted companies. */
interface PairPath {
  aId: string;
  bId: string;
  aName: string;
  bName: string;
  /** Up to MAX_PATHS_PER_PAIR simple paths a → b, shortest first; empty when none exist. */
  paths: PathHop[][];
}

type Adjacency = Map<string, Array<{ to: string; label: RelationType; key: string }>>;

/** Stable empty id set, so memos that "match nothing" keep a referentially stable value. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Canonical undirected key for an edge, including its relation label. */
function linkEdgeKey(source: string | GraphNode, target: string | GraphNode, label: string): string {
  const s = endpointId(source);
  const t = endpointId(target);
  const [a, b] = s < t ? [s, t] : [t, s];
  return `${a}|${b}|${label}`;
}

/**
 * Up to `maxPaths` distinct simple undirected paths (≤ maxDepth hops) between two
 * nodes, mirroring the Neo4j `MATCH path = (a)-[*1..5]-(b) ... LIMIT n` traversal.
 * BFS over partial paths yields them shortest-first; parallel edges of different
 * relation types count as distinct connections. Returns `[[]]` when from === to
 * and `[]` when no path exists within maxDepth.
 */
function findPaths(
  adj: Adjacency,
  from: string,
  to: string,
  maxDepth: number,
  maxPaths: number,
): PathHop[][] {
  if (from === to) return [[]];
  const results: PathHop[][] = [];
  // FIFO queue of partial paths → dequeued shortest-first, so the earliest
  // completions are the shortest paths.
  const queue: Array<{ node: string; hops: PathHop[]; visited: Set<string> }> = [
    { node: from, hops: [], visited: new Set([from]) },
  ];
  let explored = 0;
  while (queue.length > 0 && results.length < maxPaths) {
    const cur = queue.shift()!;
    if (cur.hops.length >= maxDepth) continue;
    if (++explored > PATH_EXPLORE_CAP) break;
    for (const edge of adj.get(cur.node) ?? []) {
      if (cur.visited.has(edge.to)) continue; // simple paths only — no revisits
      const hop: PathHop = { fromId: cur.node, toId: edge.to, label: edge.label, key: edge.key };
      if (edge.to === to) {
        results.push([...cur.hops, hop]);
        if (results.length >= maxPaths) break;
        continue;
      }
      const visited = new Set(cur.visited);
      visited.add(edge.to);
      queue.push({ node: edge.to, hops: [...cur.hops, hop], visited });
    }
  }
  return results;
}

/** Build a minimal CompanyData from a graph node when the company isn't in Postgres. */
function fallbackCompany(node: GraphNode): CompanyData {
  const nowIso = new Date().toISOString();
  return {
    id: node.id,
    target: node.name,
    project_name: null,
    segment: node.segment ?? null,
    website: null,
    watchlist_status: null,
    pipeline_stage: null,
    revenue_2021_usd_mn: null,
    revenue_2022_usd_mn: null,
    revenue_2023_usd_mn: null,
    revenue_2024_usd_mn: null,
    ebitda_2021_usd_mn: null,
    ebitda_2022_usd_mn: null,
    ebitda_2023_usd_mn: null,
    ebitda_2024_usd_mn: null,
    ev_2024: null,
    l1_screening_result: null,
    remarks: null,
    created_at: nowIso,
    updated_at: nowIso,
    source: null,
    status: null,
    dropped_reason: null,
    dropped_at: null,
    ownership: node.ownership ? node.ownership === 'public' ? 'Public' : 'Private' : null,
    geography: node.geography ?? null,
  };
}

interface CompanyGraphProps {
  /** When true, the edit-mode "Combine companies" section is available. */
  isWorkspaceAdmin?: boolean;
}

export default function CompanyGraph({
  isWorkspaceAdmin = false,
}: CompanyGraphProps) {
  // Every filter is mirrored into the URL so a filtered graph is shareable as a
  // link. The query string is read exactly once, to seed the state below; from
  // then on the filters are client state and this component writes the URL,
  // never the other way round. See `@/lib/graph/graphFilterParams`.
  const searchParams = useSearchParams();
  const [initialFilters] = useState(() => decodeGraphFilters(searchParams));

  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const workspaceStages = usePipelineStages();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Force-graph component is loaded client-side only (it touches `window`).
  // Loading it directly (rather than via next/dynamic) keeps the imperative
  // ref intact so we can pan/zoom programmatically from the search box.
  const [ForceGraph2D, setForceGraph2D] = useState<any>(null);
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // ─── Filters ──────────────────────────────────────────────────────────────
  // Not a node filter — it centres and zooms the canvas on the match — but it
  // rides in the URL too, and is re-applied once the layout settles (see
  // `onEngineStop`), so a shared link lands on the same view.
  const [search, setSearch] = useState(initialFilters.search);
  // "Highlight" companies: when non-empty, the graph is pinned to exactly these
  // companies and the relationships between them (all other filters are
  // bypassed so the selection is shown verbatim).
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(
    () => new Set(initialFilters.highlighted),
  );
  // "Show connected companies": widens the highlight view to also include every
  // company with a direct edge to a highlighted one.
  const [showConnectedCompanies, setShowConnectedCompanies] = useState(
    initialFilters.showConnectedCompanies,
  );
  // Company filters are multi-select: an empty Set means "no filter" (show all).
  const [ownership, setOwnership] = useState<Set<Ownership>>(
    () => new Set(initialFilters.ownership),
  );
  const [geography, setGeography] = useState<Set<string>>(() => new Set(initialFilters.geography));
  const [sector, setSector] = useState<Set<string>>(() => new Set(initialFilters.sector));
  const [pipelineStage, setPipelineStage] = useState<Set<string>>(
    () => new Set(initialFilters.pipelineStage),
  );
  const [status, setStatus] = useState<Set<string>>(() => new Set(initialFilters.status));
  const [enabledTypes, setEnabledTypes] = useState<Set<RelationFilter>>(
    () => new Set<RelationFilter>(initialFilters.relationTypes),
  );
  const [hasEvidenceOnly, setHasEvidenceOnly] = useState(initialFilters.hasEvidenceOnly);
  const [dateFrom, setDateFrom] = useState(initialFilters.dateFrom);
  const [dateTo, setDateTo] = useState(initialFilters.dateTo);

  // Right-click "Display only connected companies": when set to a node, the
  // graph is restricted to that node plus its direct neighbours (companies with
  // an edge to it, in either direction).
  const [connectedTo, setConnectedTo] = useState<GraphNode | null>(null);
  // Position + target of the node right-click context menu (null = closed).
  const [contextMenu, setContextMenu] = useState<{
    node: GraphNode;
    x: number;
    y: number;
  } | null>(null);

  // ─── Company detail modal ───────────────────────────────────────────────────
  const [selectedCompany, setSelectedCompany] = useState<CompanyData | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // ─── Edge (relationship) detail modal ───────────────────────────────────────
  const [selectedLink, setSelectedLink] = useState<{
    label: string;
    evidence?: string;
    date?: string;
    notes?: string;
    sourceName: string;
    targetName: string;
  } | null>(null);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  // ─── Edit mode ─────────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);

  // Whether the settings/filters overlay card is expanded (collapsible).
  const [settingsOpen, setSettingsOpen] = useState(true);

  // Edit link dialog state — holds both the Neo4j key (raw*) and editable form values.
  const [editingLink, setEditingLink] = useState<{
    rawSourceId: string;
    rawTargetId: string;
    rawType: RelationType;
    fromId: string;
    toId: string;
    type: RelationType;
    notes: string;
    evidence: string;
    date: string;
  } | null>(null);
  const [editLinkOpen, setEditLinkOpen] = useState(false);
  const [editLinkSaving, setEditLinkSaving] = useState(false);
  const [editLinkDeleting, setEditLinkDeleting] = useState(false);

  // Add connection form state
  const [addConn, setAddConn] = useState({
    fromId: '',
    toId: '',
    type: 'PARTNER' as RelationType,
    notes: '',
  });
  const [addConnSaving, setAddConnSaving] = useState(false);

  // Add company form state
  const [addCompanyName, setAddCompanyName] = useState('');
  const [addCompanyError, setAddCompanyError] = useState<string | null>(null);
  const [addCompanySaving, setAddCompanySaving] = useState(false);

  // Remove node dialog state
  const [removeNodeTarget, setRemoveNodeTarget] = useState<GraphNode | null>(null);
  const [removeNodeOpen, setRemoveNodeOpen] = useState(false);
  const [removeNodeReplacement, setRemoveNodeReplacement] = useState('');
  const [removeNodeSaving, setRemoveNodeSaving] = useState(false);

  // Node size override dialog state
  const [nodeSizeTarget, setNodeSizeTarget] = useState<GraphNode | null>(null);
  const [nodeSizeOpen, setNodeSizeOpen] = useState(false);
  // null = "Auto" (derive from EV); 1–5 = explicit override
  const [nodeSizeValue, setNodeSizeValue] = useState<number | null>(null);
  const [nodeSizeSaving, setNodeSizeSaving] = useState(false);

  // Combine companies form state (workspace-admin only). `combineIds` are the
  // companies selected to merge; `combineMainId` is the surviving company (must
  // be one of the selected).
  const [combineIds, setCombineIds] = useState<string[]>([]);
  const [combineMainId, setCombineMainId] = useState('');
  const [combineSaving, setCombineSaving] = useState(false);

  useEffect(() => {
    import('react-force-graph-2d').then((mod) => setForceGraph2D(() => mod.default));
  }, []);

  // Fetch the graph from Neo4j. Reused on mount and after a database sync.
  const loadGraph = useCallback(async () => {
    const res = await fetch('/api/graph');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    setGraphData(json.data);
  }, []);

  useEffect(() => {
    loadGraph()
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load graph'))
      .finally(() => setLoading(false));
  }, [loadGraph]);

  // `?connectedTo=` is the one filter that can also arrive *after* mount: the
  // company detail dialog this view renders embeds the relationship snippet,
  // whose "Show in relationship graph" button links back to
  // `/graph?connectedTo=<id>` — a soft navigation on the same route, which
  // leaves this component mounted and only updates `searchParams`. So it's read
  // live rather than from `initialFilters`.
  const urlConnectedCompanyId = searchParams.get(GRAPH_FILTER_PARAMS.connectedTo)?.trim() || null;
  // Which URL-supplied id has been consumed — either resolved to its node or
  // found to be missing from the graph. State rather than a ref, so consuming an
  // id re-renders and lets the URL sync below drop it. Until an id is consumed
  // the sync keeps it in the URL, so a link can't be stripped before it applies.
  //
  // Consumed ids are never un-consumed, so clearing the pin and then following
  // the *same* company's link again (without leaving the page) doesn't re-pin it
  // — long-standing behaviour, and the tradeoff of syncing the URL with
  // `history.replaceState`: it deliberately doesn't feed Next's router, so
  // `searchParams` still reports the id we already consumed and re-applying from
  // it would fight the user's clear. Routing the sync through `router.replace`
  // instead would fix that at the cost of a server round trip per filter click.
  const [consumedConnectedId, setConsumedConnectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!urlConnectedCompanyId || consumedConnectedId === urlConnectedCompanyId) return;
    const node = graphData.nodes.find((n) => n.id === urlConnectedCompanyId);
    if (!node) {
      // Once the graph has loaded without it, the id is a dead link — consume it
      // so it stops pinning the URL. (While still loading, wait for the nodes.)
      if (!loading) setConsumedConnectedId(urlConnectedCompanyId);
      return;
    }
    setConsumedConnectedId(urlConnectedCompanyId);
    setConnectedTo(node);
  }, [urlConnectedCompanyId, consumedConnectedId, graphData.nodes, loading]);

  // ─── URL sync ───────────────────────────────────────────────────────────────
  // Mirror the filter panel into the query string so the current view can be
  // shared as a link. `history.replaceState` (not router.replace) updates the
  // URL bar without a Next.js soft navigation, so the server component doesn't
  // re-run and the canvas doesn't remount mid-filtering.
  const graphHref = useWorkspaceHref('/graph');
  const filterQuery = useMemo(
    () =>
      encodeGraphFilters({
        search,
        highlighted: [...highlightedIds],
        // Only meaningful alongside a highlight selection — without one the
        // checkbox is inert, so keep it out of shared links.
        showConnectedCompanies: showConnectedCompanies && highlightedIds.size > 0,
        connectedTo:
          connectedTo?.id ??
          (urlConnectedCompanyId !== consumedConnectedId ? urlConnectedCompanyId : null),
        ownership: [...ownership],
        geography: [...geography],
        sector: [...sector],
        pipelineStage: [...pipelineStage],
        status: [...status],
        relationTypes: [...enabledTypes],
        hasEvidenceOnly,
        dateFrom,
        dateTo,
      }),
    [
      search,
      highlightedIds,
      showConnectedCompanies,
      connectedTo,
      urlConnectedCompanyId,
      consumedConnectedId,
      ownership,
      geography,
      sector,
      pipelineStage,
      status,
      enabledTypes,
      hasEvidenceOnly,
      dateFrom,
      dateTo,
    ],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = filterQuery ? `${graphHref}?${filterQuery}` : graphHref;
    if (`${window.location.pathname}${window.location.search}` === target) return;
    window.history.replaceState(null, '', target);
  }, [filterQuery, graphHref]);

  // Reconcile the graph DB from Postgres (the source of truth), then reload.
  // The sync runs as a background job; we poll it to completion before
  // refetching so the canvas reflects the reconciled graph.
  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    const toastId = toast.loading('Syncing graph from database…');
    try {
      const res = await fetch('/api/graph/sync', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = await res.json();
      const job = await waitForJob(data.jobId);
      if (job.status !== 'completed') {
        throw new Error(job.error || `Sync ${job.status}`);
      }
      await loadGraph();
      const result = (job.result ?? {}) as { upserted?: number; deleted?: number };
      toast.success(
        `Graph synced — ${result.upserted ?? 0} companies, ${result.deleted ?? 0} removed`,
        { id: toastId },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed', { id: toastId });
    } finally {
      setSyncing(false);
    }
  }, [syncing, loadGraph]);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Distinct geographies for the dropdown.
  const geographies = useMemo(() => {
    const set = new Set<string>();
    for (const n of graphData.nodes) if (n.geography) set.add(n.geography);
    return Array.from(set).sort();
  }, [graphData.nodes]);

  // Distinct sectors (company `segment`) for the dropdown.
  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const n of graphData.nodes) if (n.segment) set.add(n.segment);
    return Array.from(set).sort();
  }, [graphData.nodes]);

  // Distinct pipeline stages present in the graph, ordered by the canonical
  // pipeline progression with any unknown values trailing. Nodes missing a
  // stage contribute the `NO_STAGE` sentinel so they remain filterable.
  const pipelineStages = useMemo(() => {
    const set = new Set<string>();
    let hasMissing = false;
    for (const n of graphData.nodes) {
      if (n.pipelineStage) set.add(n.pipelineStage);
      else hasMissing = true;
    }
    // Pre-pipeline buckets first, then the workspace's stages in pipeline order.
    const order = ['market_screening', 'unreviewed', ...workspaceStages.liveKeys, 'discovered'];
    const sorted = Array.from(set).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return hasMissing ? [...sorted, NO_STAGE] : sorted;
  }, [graphData.nodes, workspaceStages.liveKeys]);

  // When a "connected only" node is pinned, the set of node ids allowed through
  // the filter: the node itself plus every company sharing an edge with it.
  // Derived from the full (unfiltered) link set so it's an intrinsic neighbour
  // relation, independent of the active edge-type filters.
  const connectedIds = useMemo(() => {
    if (!connectedTo) return null;
    const ids = neighborIds(graphData.links, new Set([connectedTo.id]));
    ids.add(connectedTo.id);
    return ids;
  }, [connectedTo, graphData.links]);

  // The relationship characteristics each company "owns", derived from the full
  // (unfiltered) edge set: the set of relation types on its incident edges, or
  // `NONE` when it has no relationships at all. This is an intrinsic property of
  // the company, so it's computed independently of the active edge-type filter.
  const nodeCharacteristics = useMemo(() => {
    const map = new Map<string, Set<RelationType>>();
    for (const l of graphData.links) {
      const type = l.label as RelationType;
      if (!RELATION_COLORS[type]) continue;
      for (const id of [endpointId(l.source), endpointId(l.target)]) {
        const set = map.get(id) ?? new Set<RelationType>();
        set.add(type);
        map.set(id, set);
      }
    }
    return map;
  }, [graphData.links]);

  // Company id → display name, used by pathfinding and the edge/detail dialogs.
  const nodeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of graphData.nodes) map.set(n.id, n.name);
    return map;
  }, [graphData.nodes]);

  // Undirected adjacency over the full (unfiltered) edge set, used to trace
  // connection paths between highlighted companies. Rebuilt only when the graph
  // itself changes, so it's independent of the active filters.
  const adjacency = useMemo<Adjacency>(() => {
    const adj: Adjacency = new Map();
    const add = (from: string, to: string, label: RelationType, key: string) => {
      const arr = adj.get(from);
      if (arr) arr.push({ to, label, key });
      else adj.set(from, [{ to, label, key }]);
    };
    for (const l of graphData.links) {
      const s = endpointId(l.source);
      const t = endpointId(l.target);
      const label = l.label as RelationType;
      const key = linkEdgeKey(s, t, l.label);
      add(s, t, label, key);
      add(t, s, label, key);
    }
    return adj;
  }, [graphData.links]);

  // For every unique pair of highlighted companies, up to MAX_PATHS_PER_PAIR
  // alternative connection paths (≤ MAX_PATH_DEPTH hops), shortest first —
  // mirroring the Neo4j `MATCH path = (a)-[*1..5]-(b) ... LIMIT n` traversal. Also
  // accumulates every node and edge lying on any path so the canvas can render the
  // intermediaries, not just the highlighted companies themselves.
  const highlightPaths = useMemo(() => {
    const pathNodeIds = new Set<string>(highlightedIds);
    const pathEdgeKeys = new Set<string>();
    const pairs: PairPath[] = [];
    if (highlightedIds.size < 2) return { pairs, pathNodeIds, pathEdgeKeys };

    const ids = [...highlightedIds].sort((a, b) =>
      (nodeNameById.get(a) ?? a).localeCompare(nodeNameById.get(b) ?? b),
    );
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const from = ids[i];
        const to = ids[j];
        const paths = findPaths(adjacency, from, to, MAX_PATH_DEPTH, MAX_PATHS_PER_PAIR);
        pairs.push({
          aId: from,
          bId: to,
          aName: nodeNameById.get(from) ?? from,
          bName: nodeNameById.get(to) ?? to,
          paths,
        });
        for (const path of paths) {
          for (const hop of path) {
            pathNodeIds.add(hop.fromId);
            pathNodeIds.add(hop.toId);
            pathEdgeKeys.add(hop.key);
          }
        }
      }
    }
    return { pairs, pathNodeIds, pathEdgeKeys };
  }, [highlightedIds, adjacency, nodeNameById]);

  // Companies with a direct edge to a highlighted one, surfaced only while the
  // "Show connected companies" checkbox is on (otherwise the empty set keeps the
  // highlight view restricted to the selection and its connection paths).
  const highlightNeighborIds = useMemo(() => {
    if (!showConnectedCompanies || highlightedIds.size === 0) return EMPTY_IDS;
    return neighborIds(graphData.links, highlightedIds);
  }, [showConnectedCompanies, highlightedIds, graphData.links]);

  // How many companies the checkbox actually adds to the canvas — neighbours
  // already visible as a connection-path intermediary don't count.
  const addedNeighborCount = useMemo(
    () => [...highlightNeighborIds].filter((id) => !highlightPaths.pathNodeIds.has(id)).length,
    [highlightNeighborIds, highlightPaths],
  );

  // Apply node + edge filters. Rebuilds fresh node/link objects so force-graph's
  // in-place mutation never bleeds back into the raw data. Excludes `hovered`
  // from deps so hovering doesn't restart the simulation.
  const filteredData = useMemo<GraphData>(() => {
    // Highlight takes precedence: when companies are highlighted, show only
    // those companies and the relationships between them, ignoring the other
    // filters entirely.
    const highlighting = highlightedIds.size > 0;

    const nodes = graphData.nodes.filter((n) => {
      // When highlighting, keep the selected companies plus every company that
      // lies on a connection path between a highlighted pair — and, with "Show
      // connected companies" on, their direct neighbours too.
      if (highlighting) {
        return highlightPaths.pathNodeIds.has(n.id) || highlightNeighborIds.has(n.id);
      }
      // Multi-select filters: an empty Set means the filter is inactive.
      if (ownership.size > 0 && (!n.ownership || !ownership.has(n.ownership))) return false;
      if (geography.size > 0 && (!n.geography || !geography.has(n.geography))) return false;
      if (sector.size > 0 && (!n.segment || !sector.has(n.segment))) return false;
      if (pipelineStage.size > 0 && !pipelineStage.has(n.pipelineStage ?? NO_STAGE)) return false;
      if (status.size > 0 && (!n.status || !status.has(n.status))) return false;
      // "Display only connected companies": restrict to the pinned node and its
      // direct neighbours.
      if (connectedIds && !connectedIds.has(n.id)) return false;

      // Relationship filter: keep a company only if it owns at least one of the
      // currently-enabled characteristics. A company with no relationships owns
      // the `NONE` characteristic; deselecting a type drops the companies whose
      // only relationships are of de-selected types.
      const chars = nodeCharacteristics.get(n.id);
      if (!chars || chars.size === 0) {
        if (!enabledTypes.has(NO_RELATION)) return false;
      } else if (![...chars].some((c) => enabledTypes.has(c))) {
        return false;
      }
      return true;
    });
    const keptIds = new Set(nodes.map((n) => n.id));

    const links = graphData.links.filter((l) => {
      const sid = endpointId(l.source);
      const tid = endpointId(l.target);
      if (!keptIds.has(sid) || !keptIds.has(tid)) return false;
      // When highlighting, show every direct relationship between two selected
      // companies plus the edges that make up a connection path between a pair,
      // regardless of the edge-type / evidence / date filters.
      if (highlighting) {
        if (highlightedIds.has(sid) && highlightedIds.has(tid)) return true;
        if (highlightPaths.pathEdgeKeys.has(linkEdgeKey(sid, tid, l.label))) return true;
        // With "Show connected companies" on, also draw the edge that attaches
        // each neighbour to the highlighted company it hangs off.
        return (
          (highlightedIds.has(sid) && highlightNeighborIds.has(tid)) ||
          (highlightedIds.has(tid) && highlightNeighborIds.has(sid))
        );
      }
      if (!enabledTypes.has(l.label as RelationType)) return false;
      if (hasEvidenceOnly && !l.evidence) return false;
      if (dateFrom && (!l.date || l.date < dateFrom)) return false;
      if (dateTo && (!l.date || l.date > dateTo)) return false;
      return true;
    });

    return {
      nodes: nodes.map((n) => ({ ...n, val: nodeDisplaySize(n) })),
      links: links.map((l) => {
        const source = endpointId(l.source);
        const target = endpointId(l.target);
        // INVESTED_IN is stored as investor(source) -> investee(target), but the
        // graph's arrow should read the other way. Swap the endpoints for this
        // relation type only so the drawn arrow (and the edge-detail dialog,
        // which reads from these endpoints) point in the correct direction.
        const reversed = (l.label as RelationType) === 'INVESTED_IN';
        return {
          source: reversed ? target : source,
          target: reversed ? source : target,
          label: l.label,
          evidence: l.evidence,
          date: l.date,
          notes: l.notes,
        };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, ownership, geography, sector, pipelineStage, status, connectedIds, enabledTypes, hasEvidenceOnly, dateFrom, dateTo, nodeCharacteristics, highlightedIds, highlightPaths, highlightNeighborIds]);

  // Each node's dominant relationship type, rendered as the sub-label inside
  // the circle.
  const nodePrimaryRelation = useMemo(
    () => primaryRelationByNode(filteredData.links),
    [filteredData],
  );

  const relationTypeCount = useMemo(
    () => new Set(filteredData.links.map((l) => l.label)).size,
    [filteredData],
  );

  const sortedNodes = useMemo(
    () => [...graphData.nodes].sort((a, b) => a.name.localeCompare(b.name)),
    [graphData.nodes],
  );

  // Tune the force simulation so connected nodes get enough breathing room for
  // their edges to read clearly, while disconnected sub-graphs stay grouped
  // toward the centre rather than drifting to the corners.
  const didFitRef = useRef(false);
  // One-shot latch for the `?q=` seed, which rides on the same settle callback as
  // the fit below but must not repeat when the simulation reheats.
  const didInitialSearchRef = useRef(false);
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || !ForceGraph2D) return;

    const radiusOf = (n: GraphNode) => estimateNodeRadius(nodeSizeFactor(n));

    // Collision keeps circles from overlapping; the extra padding leaves a gap
    // wide enough to see the edges between them.
    fg.d3Force('collide', forceCollide((n: GraphNode) => radiusOf(n) + 10).strength(1));

    // Link distance scales with both endpoints' sizes plus a fixed gap so edges
    // are always visible regardless of label length.
    const linkForce = fg.d3Force('link');
    if (linkForce) {
      linkForce.distance((l: { source: GraphNode; target: GraphNode }) =>
        radiusOf(l.source) + radiusOf(l.target) + 70,
      );
    }

    // Mild, short-range repulsion: enough to spread local clusters but capped so
    // far-apart components aren't pushed even further away.
    const charge = fg.d3Force('charge');
    if (charge) charge.strength(-90).distanceMax(280);

    // Gentle pull toward the origin gathers separate sub-graphs together.
    fg.d3Force('x', forceX(0).strength(0.08));
    fg.d3Force('y', forceY(0).strength(0.08));

    didFitRef.current = false;
    fg.d3ReheatSimulation();
  }, [ForceGraph2D, filteredData, nodePrimaryRelation]);

  const toggleType = (type: RelationFilter) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleHighlight = useCallback((id: string) => {
    setHighlightedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearHighlight = useCallback(() => setHighlightedIds(new Set()), []);

  // Centre and zoom the canvas on the company matching `term` (exact name first,
  // then substring). Returns whether it found one — the initial `?q=` from a
  // shared link uses that to decide whether it still needs the default
  // fit-to-screen. Only meaningful once the force layout has given nodes
  // coordinates, so callers run it after the engine has settled.
  const runSearch = useCallback(
    (term: string): boolean => {
      const q = term.trim().toLowerCase();
      if (!q || !graphRef.current) return false;
      const match =
        filteredData.nodes.find((n) => n.name.toLowerCase() === q) ??
        filteredData.nodes.find((n) => n.name.toLowerCase().includes(q));
      if (!match) return false;
      const n = match as GraphNode & { x?: number; y?: number };
      graphRef.current.centerAt(n.x ?? 0, n.y ?? 0, 800);
      graphRef.current.zoom(5, 800);
      setHovered(match);
      return true;
    },
    [filteredData.nodes],
  );

  const handleSearch = () => runSearch(search);

  const handleNodeClick = (node: GraphNode) => {
    // Seed the dialog with what the graph node already knows so it opens
    // instantly. The dialog re-fetches the authoritative company DTO (and its
    // details) itself on open, so we deliberately don't fetch here — a second
    // fetch races the dialog's own load and is what caused the flicker /
    // stale-company content. The `key` on <CompanyDetailDialog> guarantees a
    // fresh instance per company, so no previous company's state ever leaks in.
    setSelectedCompany(fallbackCompany(node));
    setDialogOpen(true);
  };

  const handleNodeRightClick = (node: GraphNode, event: MouseEvent) => {
    event.preventDefault();
    setContextMenu({ node, x: event.clientX, y: event.clientY });
  };

  // Open the relationship detail (or edit) dialog for a clicked edge.
  // `link` comes from filteredData, which swaps INVESTED_IN endpoints for display;
  // rawSourceId/rawTargetId unswap them back to the Neo4j stored direction.
  const handleLinkClick = (link: GraphLink) => {
    const sourceId = endpointId(link.source);
    const targetId = endpointId(link.target);
    const nameOf = (endpoint: string | GraphNode, id: string) =>
      (typeof endpoint === 'object' ? endpoint.name : undefined) ??
      nodeNameById.get(id) ??
      id;

    const isInvested = (link.label as RelationType) === 'INVESTED_IN';
    const rawSourceId = isInvested ? targetId : sourceId;
    const rawTargetId = isInvested ? sourceId : targetId;
    const rawType = link.label as RelationType;

    if (editMode) {
      setEditingLink({
        rawSourceId,
        rawTargetId,
        rawType,
        fromId: rawSourceId,
        toId: rawTargetId,
        type: rawType,
        notes: link.notes ?? '',
        evidence: link.evidence ?? '',
        date: link.date ?? '',
      });
      setEditLinkOpen(true);
    } else {
      setSelectedLink({
        label: link.label,
        evidence: link.evidence,
        date: link.date,
        notes: link.notes,
        sourceName: nameOf(link.source, sourceId),
        targetName: nameOf(link.target, targetId),
      });
      setLinkDialogOpen(true);
    }
  };

  // Toggle the "connected only" filter for the right-clicked node. Selecting a
  // new node pins it; re-selecting the already-pinned node removes the filter.
  const toggleConnectedOnly = (node: GraphNode) => {
    setConnectedTo((prev) => (prev?.id === node.id ? null : node));
    setContextMenu(null);
  };

  const openRemoveNode = (node: GraphNode) => {
    setRemoveNodeTarget(node);
    setRemoveNodeReplacement('');
    setRemoveNodeOpen(true);
    setContextMenu(null);
  };

  const openNodeSize = (node: GraphNode) => {
    setNodeSizeTarget(node);
    setNodeSizeValue(node.graphSizeOverride ?? null);
    setNodeSizeOpen(true);
    setContextMenu(null);
  };

  const handleNodeSizeSave = async () => {
    if (!nodeSizeTarget) return;
    setNodeSizeSaving(true);
    try {
      const res = await fetch('/api/graph/node', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: nodeSizeTarget.id, sizeOverride: nodeSizeValue }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadGraph();
      setNodeSizeOpen(false);
      toast.success('Node size updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update size');
    } finally {
      setNodeSizeSaving(false);
    }
  };

  const handleRemoveNode = async () => {
    if (!removeNodeTarget) return;
    setRemoveNodeSaving(true);
    try {
      const res = await fetch('/api/graph/company', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: removeNodeTarget.id,
          replacementId: removeNodeReplacement || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await loadGraph();
      setRemoveNodeOpen(false);
      toast.success(`${removeNodeTarget.name} removed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove node');
    } finally {
      setRemoveNodeSaving(false);
    }
  };

  const handleEditLinkSave = async () => {
    if (!editingLink) return;
    if (editingLink.fromId === editingLink.toId) {
      toast.error('From and To companies must be different');
      return;
    }
    setEditLinkSaving(true);
    try {
      const res = await fetch('/api/graph/relation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawSourceId: editingLink.rawSourceId,
          rawTargetId: editingLink.rawTargetId,
          rawType: editingLink.rawType,
          sourceId: editingLink.fromId,
          targetId: editingLink.toId,
          type: editingLink.type,
          notes: editingLink.notes,
          evidence: editingLink.evidence,
          date: editingLink.date,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadGraph();
      setEditLinkOpen(false);
      toast.success('Relationship updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setEditLinkSaving(false);
    }
  };

  const handleEditLinkDelete = async () => {
    if (!editingLink) return;
    setEditLinkDeleting(true);
    try {
      const res = await fetch('/api/graph/relation', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: editingLink.rawSourceId,
          targetId: editingLink.rawTargetId,
          type: editingLink.rawType,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadGraph();
      setEditLinkOpen(false);
      toast.success('Relationship deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setEditLinkDeleting(false);
    }
  };

  const handleAddConnection = async () => {
    if (!addConn.fromId || !addConn.toId) {
      toast.error('Please select both From and To companies');
      return;
    }
    if (addConn.fromId === addConn.toId) {
      toast.error('From and To companies must be different');
      return;
    }
    setAddConnSaving(true);
    try {
      const res = await fetch('/api/graph/relation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: addConn.fromId,
          targetId: addConn.toId,
          type: addConn.type,
          notes: addConn.notes,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadGraph();
      setAddConn({ fromId: '', toId: '', type: 'PARTNER', notes: '' });
      toast.success('Connection added');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add connection');
    } finally {
      setAddConnSaving(false);
    }
  };

  const handleAddCompany = async () => {
    const name = addCompanyName.trim();
    if (!name) return;
    setAddCompanyError(null);
    setAddCompanySaving(true);
    try {
      const res = await fetch('/api/graph/company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (res.status === 409) {
        setAddCompanyError(json.error);
        return;
      }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await loadGraph();
      setAddCompanyName('');
      toast.success(`Company added to Discovered`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add company');
    } finally {
      setAddCompanySaving(false);
    }
  };

  const toggleCombineId = (id: string) => {
    setCombineIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      // Keep the main selection valid: default it to the first pick, and clear
      // it if the current main was just removed.
      setCombineMainId((main) => {
        if (next.length === 0) return '';
        if (!main || !next.includes(main)) return next[0];
        return main;
      });
      return next;
    });
  };

  const handleCombine = async () => {
    if (combineIds.length < 2) {
      toast.error('Select at least two companies to combine');
      return;
    }
    if (!combineMainId || !combineIds.includes(combineMainId)) {
      toast.error('Select which company is the main one');
      return;
    }
    const otherIds = combineIds.filter((id) => id !== combineMainId);
    setCombineSaving(true);
    try {
      const res = await fetch('/api/graph/combine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mainId: combineMainId, otherIds }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await loadGraph();
      const mainName = graphData.nodes.find((n) => n.id === combineMainId)?.name ?? 'company';
      setCombineIds([]);
      setCombineMainId('');
      toast.success(`Combined ${otherIds.length} compan${otherIds.length === 1 ? 'y' : 'ies'} into ${mainName}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to combine companies');
    } finally {
      setCombineSaving(false);
    }
  };

  // Dismiss the context menu on scroll or Escape. (A left-click anywhere else is
  // caught by the full-screen overlay rendered beneath the menu.)
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const ready = !loading && !error && ForceGraph2D && graphData.nodes.length > 0;

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="relative flex flex-1 min-h-0 p-4">
          {/* Filters + legend — a collapsible card overlaid on the graph */}
          <aside className="absolute top-7 left-7 z-20 flex max-h-[calc(100%-3.5rem)] w-72 max-w-[calc(100%-3.5rem)] flex-col overflow-hidden rounded-xl border border-slate-300/70 bg-white/95 shadow-lg backdrop-blur-sm">
            {/* Header — always visible; toggles the collapsible body */}
            <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2">
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 text-left"
                onClick={() => setSettingsOpen((v) => !v)}
                aria-expanded={settingsOpen}
              >
                {settingsOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <h1 className="truncate text-sm font-bold tracking-tight">Relationship Graph</h1>
              </button>
              <Button
                variant={editMode ? 'default' : 'outline'}
                size="sm"
                className="h-7 px-2 text-xs gap-1 shrink-0"
                onClick={() => setEditMode((v) => !v)}
              >
                <Pencil className="h-3 w-3" />
                {editMode ? 'Editing' : 'Edit'}
              </Button>
            </div>
            {settingsOpen && (
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
                {/* Title */}
                <div>
                  <p className="text-xs text-muted-foreground">
                    M&amp;A portfolio visualization
                  </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full h-8 text-xs"
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {syncing ? 'Syncing…' : 'Sync now'}
              </Button>
              <p className="text-[11px] text-muted-foreground/80 mt-1.5">
                Reconcile the graph from the company database.
              </p>
            </div>

            {/* Add connection (edit mode only) */}
            {editMode && (
              <div className="space-y-3 rounded-lg border border-dashed border-blue-300 bg-blue-50/60 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-blue-900 uppercase tracking-wider">
                  <Plus className="h-3.5 w-3.5" />
                  Add connection
                </p>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">From</Label>
                  <NodeCombobox
                    nodes={sortedNodes}
                    value={addConn.fromId}
                    onChange={(id) => setAddConn((p) => ({ ...p, fromId: id }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">To</Label>
                  <NodeCombobox
                    nodes={sortedNodes}
                    value={addConn.toId}
                    onChange={(id) => setAddConn((p) => ({ ...p, toId: id }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Type</Label>
                  <Select
                    value={addConn.type}
                    onValueChange={(v) => setAddConn((p) => ({ ...p, type: v as RelationType }))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RELATION_TYPES.map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          {RELATION_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Notes</Label>
                  <Textarea
                    value={addConn.notes}
                    onChange={(e) => setAddConn((p) => ({ ...p, notes: e.target.value }))}
                    placeholder="Optional notes…"
                    className="h-16 text-xs resize-none"
                  />
                </div>
                <Button
                  size="sm"
                  className="w-full h-8 text-xs"
                  onClick={handleAddConnection}
                  disabled={addConnSaving}
                >
                  {addConnSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  {addConnSaving ? 'Adding…' : 'Add connection'}
                </Button>
              </div>
            )}

            {/* Add company (edit mode only) */}
            {editMode && (
              <div className="space-y-3 rounded-lg border border-dashed border-blue-300 bg-blue-50/60 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-blue-900 uppercase tracking-wider">
                  <Plus className="h-3.5 w-3.5" />
                  Add company
                </p>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Company name</Label>
                  <Input
                    value={addCompanyName}
                    onChange={(e) => {
                      setAddCompanyName(e.target.value);
                      setAddCompanyError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddCompany();
                    }}
                    placeholder="e.g. Acme Corp…"
                    className="h-8 text-xs"
                  />
                  {addCompanyError && (
                    <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 leading-snug">
                      {addCompanyError}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  className="w-full h-8 text-xs"
                  onClick={handleAddCompany}
                  disabled={addCompanySaving || !addCompanyName.trim()}
                >
                  {addCompanySaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  {addCompanySaving ? 'Adding…' : 'Add to Discovered'}
                </Button>
              </div>
            )}

            {/* Combine companies (edit mode, workspace admins only) */}
            {editMode && isWorkspaceAdmin && (
              <div className="space-y-3 rounded-lg border border-dashed border-rose-300 bg-rose-50/60 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-900 uppercase tracking-wider">
                  <Combine className="h-3.5 w-3.5" />
                  Combine companies
                </p>
                <p className="text-[11px] text-muted-foreground/90 leading-snug">
                  Merge duplicates into one. Every relationship on the other
                  companies moves to the main company, their names become aliases
                  of it, and the other records are deleted.
                </p>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Companies to combine</Label>
                  <CompanyMultiSelect
                    nodes={sortedNodes}
                    selected={combineIds}
                    onToggle={toggleCombineId}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Main company (kept)</Label>
                  <Select
                    value={combineMainId}
                    onValueChange={setCombineMainId}
                    disabled={combineIds.length === 0}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select the surviving company…" />
                    </SelectTrigger>
                    <SelectContent>
                      {combineIds.map((id) => {
                        const node = graphData.nodes.find((n) => n.id === id);
                        if (!node) return null;
                        return (
                          <SelectItem key={id} value={id} className="text-xs">
                            {node.name}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full h-8 text-xs"
                  onClick={handleCombine}
                  disabled={combineSaving || combineIds.length < 2 || !combineMainId}
                >
                  {combineSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Combine className="h-3.5 w-3.5" />
                  )}
                  {combineSaving
                    ? 'Combining…'
                    : combineIds.length >= 2
                      ? `Combine ${combineIds.length - (combineMainId ? 1 : 0)} into main`
                      : 'Combine'}
                </Button>
              </div>
            )}

            {/* Search */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Search
              </p>
              <div className="flex gap-1.5">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearch();
                  }}
                  placeholder="Find a company…"
                  className="h-8 text-sm"
                />
                <Button
                  size="icon"
                  variant="secondary"
                  className="h-8 w-8 shrink-0"
                  onClick={handleSearch}
                  aria-label="Search and zoom to company"
                >
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Highlight companies */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Highlight
              </p>
              <NodeMultiCombobox
                nodes={sortedNodes}
                selected={highlightedIds}
                onToggle={toggleHighlight}
                onClear={clearHighlight}
              />
              <p className="text-[11px] text-muted-foreground/80 mt-1.5">
                Show only the selected companies and how they relate to one another.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Checkbox
                  id="show-connected-companies"
                  checked={showConnectedCompanies}
                  onCheckedChange={(v) => setShowConnectedCompanies(v === true)}
                  disabled={highlightedIds.size === 0}
                />
                <Label
                  htmlFor="show-connected-companies"
                  className="text-xs font-normal cursor-pointer text-muted-foreground"
                >
                  Show connected companies
                  {addedNeighborCount > 0 && ` (+${addedNeighborCount})`}
                </Label>
              </div>
              {highlightedIds.size > 0 && (
                <div className="mt-2.5 space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Connections
                    {highlightPaths.pairs.length > 0 &&
                      ` (${highlightPaths.pairs.filter((p) => p.paths.length > 0).length}/${highlightPaths.pairs.length} pairs)`}
                  </p>
                  {highlightedIds.size < 2 ? (
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Highlight at least two companies to trace the connections between them.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {highlightPaths.pairs.map((pair) => (
                        <li
                          key={`${pair.aId}-${pair.bId}`}
                          className="space-y-1.5 rounded-md border border-slate-200 bg-white/70 p-2"
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="min-w-0 truncate text-[11px] font-semibold text-foreground">
                              {pair.aName} &harr; {pair.bName}
                            </span>
                            {pair.paths.length > 0 && (
                              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] leading-4 text-slate-600">
                                {pair.paths.length} path{pair.paths.length === 1 ? '' : 's'}
                              </span>
                            )}
                          </div>
                          {pair.paths.length === 0 ? (
                            <p className="text-[11px] leading-snug text-muted-foreground">
                              No connection within {MAX_PATH_DEPTH} hops.
                            </p>
                          ) : (
                            <div className="space-y-1.5">
                              {pair.paths.map((path, pathIdx) => (
                                <div
                                  key={`${pair.aId}-${pair.bId}-${pathIdx}`}
                                  className="space-y-0.5 border-l-2 border-slate-200 pl-2"
                                >
                                  <div className="flex items-center justify-between gap-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                                      Path {pathIdx + 1}
                                    </span>
                                    <span className="text-[10px] text-slate-400">
                                      {path.length} hop{path.length === 1 ? '' : 's'}
                                    </span>
                                  </div>
                                  <div className="truncate text-[11px] font-medium text-foreground">
                                    {pair.aName}
                                  </div>
                                  {path.map((hop, idx) => (
                                    <div
                                      key={`${hop.key}-${idx}`}
                                      className="flex items-center gap-1 pl-1 text-[11px] leading-snug"
                                    >
                                      <span
                                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                                        style={{ background: RELATION_COLORS[hop.label] ?? '#64748b' }}
                                      />
                                      <span className="shrink-0 text-muted-foreground">
                                        {RELATION_LABELS[hop.label] ?? hop.label}
                                      </span>
                                      <span className="shrink-0 text-muted-foreground">&rarr;</span>
                                      <span className="min-w-0 truncate font-medium text-foreground">
                                        {nodeNameById.get(hop.toId) ?? hop.toId}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* Company filters */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Companies
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Ownership</Label>
                <MultiSelectFilter
                  options={OWNERSHIP_OPTIONS}
                  selected={ownership}
                  onToggle={(v) => setOwnership((p) => toggledSet(p, v as Ownership))}
                  onClear={() => setOwnership(new Set())}
                  allLabel="All companies"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Geography</Label>
                <MultiSelectFilter
                  options={geographies.map((g) => ({ value: g, label: g }))}
                  selected={geography}
                  onToggle={(v) => setGeography((p) => toggledSet(p, v))}
                  onClear={() => setGeography(new Set())}
                  allLabel="All geographies"
                  searchPlaceholder="Search geography…"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Sector</Label>
                <MultiSelectFilter
                  options={sectors.map((s) => ({ value: s, label: s }))}
                  selected={sector}
                  onToggle={(v) => setSector((p) => toggledSet(p, v))}
                  onClear={() => setSector(new Set())}
                  allLabel="All sectors"
                  searchPlaceholder="Search sector…"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Pipeline stage</Label>
                <MultiSelectFilter
                  options={pipelineStages.map((s) => ({ value: s, label: pipelineStageLabel(s, workspaceStages.code) }))}
                  selected={pipelineStage}
                  onToggle={(v) => setPipelineStage((p) => toggledSet(p, v))}
                  onClear={() => setPipelineStage(new Set())}
                  allLabel="All stages"
                  searchPlaceholder="Search stage…"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Status</Label>
                <MultiSelectFilter
                  options={STATUS_OPTIONS}
                  selected={status}
                  onToggle={(v) => setStatus((p) => toggledSet(p, v))}
                  onClear={() => setStatus(new Set())}
                  allLabel="Active & dropped"
                />
              </div>
              {connectedTo && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5">
                  <span className="text-[11px] leading-tight text-blue-900">
                    Connected to{' '}
                    <span className="font-semibold">{connectedTo.name}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[11px] text-blue-700 hover:text-blue-900"
                    onClick={() => setConnectedTo(null)}
                  >
                    Clear
                  </Button>
                </div>
              )}
            </div>

            {/* Relationship (edge) filters */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Relationships
              </p>
              <ul className="space-y-2">
                {RELATION_TYPES.map((type) => (
                  <li key={type} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      id={`type-${type}`}
                      checked={enabledTypes.has(type)}
                      onCheckedChange={() => toggleType(type)}
                    />
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ background: RELATION_COLORS[type] }}
                    />
                    <Label htmlFor={`type-${type}`} className="text-xs font-normal cursor-pointer">
                      {RELATION_LABELS[type]}
                    </Label>
                  </li>
                ))}
                <li key={NO_RELATION} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    id={`type-${NO_RELATION}`}
                    checked={enabledTypes.has(NO_RELATION)}
                    onCheckedChange={() => toggleType(NO_RELATION)}
                  />
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0 border border-slate-300"
                    style={{ background: NO_RELATION_COLOR }}
                  />
                  <Label htmlFor={`type-${NO_RELATION}`} className="text-xs font-normal cursor-pointer">
                    {NO_RELATION_LABEL}
                  </Label>
                </li>
              </ul>

              <div className="flex items-center justify-between">
                <Label htmlFor="has-evidence" className="text-xs font-normal text-muted-foreground">
                  Has evidence only
                </Label>
                <Switch
                  id="has-evidence"
                  checked={hasEvidenceOnly}
                  onCheckedChange={setHasEvidenceOnly}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Date from</Label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Date to</Label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
            </div>

            {/* Hovered node info */}
            {hovered && (
              <div className="rounded-lg border bg-card p-3 text-xs space-y-1">
                <p className="font-semibold text-sm">{hovered.name}</p>
                {hovered.segment && (
                  <p className="text-muted-foreground capitalize">{hovered.segment}</p>
                )}
                {hovered.geography && (
                  <p className="text-muted-foreground">{hovered.geography}</p>
                )}
                {hovered.ownership && (
                  <p className="text-muted-foreground capitalize">{hovered.ownership}</p>
                )}
                <p className="text-muted-foreground">
                  {
                    filteredData.links.filter(
                      (l) =>
                        endpointId(l.source) === hovered.id ||
                        endpointId(l.target) === hovered.id,
                    ).length
                  }{' '}
                  connections
                </p>
                <p className="text-[11px] text-muted-foreground/80 pt-1">Click to open company card</p>
              </div>
            )}
              </div>
            )}
          </aside>

          {/* Graph canvas */}
          <div
            ref={containerRef}
            className="flex-1 rounded-2xl border border-sky-200/80 shadow-sm overflow-hidden relative"
            style={{
              backgroundColor: '#eaf2ff',
              backgroundImage:
                'radial-gradient(circle, rgba(99, 102, 241, 0.18) 1px, transparent 1px)',
              backgroundSize: '22px 22px',
            }}
          >
            {(loading || (!error && !ForceGraph2D)) && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                Loading graph…
              </div>
            )}
            {error && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive">
                {error}
              </div>
            )}
            {!loading && !error && graphData.nodes.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                No company relations found. Run <code className="mx-1 px-1 bg-muted rounded text-xs">pnpm db:seed:neo4j</code> to seed sample data.
              </div>
            )}
            {ready && (
              <div className="absolute top-3 right-3 z-10 w-56 rounded-xl border border-slate-300/70 bg-white/90 p-3 shadow-md backdrop-blur-sm">
                <p className="text-[11px] font-semibold tracking-wider text-black uppercase mb-2">Legend</p>
                <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1.5">Nodes — Stage</p>
                <ul className="space-y-1.5 mb-3">
                  {([
                    [STAGE_COLOR_BLUE, 'L0 – L5'],
                    [STAGE_COLOR_YELLOW, 'Market Scanning / No stage'],
                    [STAGE_COLOR_GREY, 'Discovered'],
                  ] as [string, string][]).map(([color, label]) => (
                    <li key={label} className="flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />
                      <span className="text-[11px] tracking-wide text-black uppercase">{label}</span>
                    </li>
                  ))}
                </ul>
                <div className="pt-2 border-t border-slate-300/80 mb-2">
                  <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1.5">Edges — Type</p>
                  <ul className="space-y-1.5">
                    {RELATION_TYPES.map((type) => (
                      <li key={`legend-${type}`} className="flex items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: RELATION_COLORS[type] }} />
                        <span className="text-[11px] tracking-wide text-black uppercase">{RELATION_LABELS[type]}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="pt-2 border-t border-slate-300/80">
                  <p className="text-[11px] tracking-wide text-black uppercase">Arrows: Source &rarr; Target</p>
                </div>
                <div className="pt-2 border-t border-slate-300/80">
                  <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">Node size</p>
                  <p className="text-[11px] text-black">1–5 scale by EV ($100B = 5)</p>
                </div>
              </div>
            )}
            {ready && (
              <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 flex items-center gap-4 rounded-full border border-slate-300/70 bg-white/90 px-5 py-2 shadow-md backdrop-blur-sm">
                <span className="text-xs text-slate-600">
                  <span className="font-bold text-slate-900">{filteredData.nodes.length}</span> Companies
                </span>
                <span className="h-3 w-px bg-slate-300" />
                <span className="text-xs text-slate-600">
                  <span className="font-bold text-slate-900">{filteredData.links.length}</span> Connections
                </span>
                <span className="h-3 w-px bg-slate-300" />
                <span className="text-xs text-slate-600">
                  <span className="font-bold text-slate-900">{relationTypeCount}</span> Types
                </span>
              </div>
            )}
            {editMode && (
              <div className="absolute top-3 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-blue-300 bg-blue-50 px-3 py-1.5 text-[11px] font-semibold text-blue-800 shadow-sm">
                <Pencil className="h-3 w-3" />
                Edit mode — click edges to edit
              </div>
            )}
            {ready && (
              <ForceGraph2D
                ref={graphRef}
                // width={dimensions.width}
                // height={dimensions.height}
                graphData={filteredData}
                // Nodes are fixed in place — dragging anywhere (including on a
                // node) pans the whole chart instead of moving a single node.
                enableNodeDrag={false}
                nodeId="id"
                nodeLabel="name"
                nodeVal="val"
                nodeRelSize={20}
                nodeColor={nodeColor}
                onNodeClick={(node: GraphNode) => handleNodeClick(node)}
                onNodeRightClick={(node: GraphNode, event: MouseEvent) =>
                  handleNodeRightClick(node, event)
                }
                nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                  const n = node as GraphNode & { x?: number; y?: number };
                  const primary = nodePrimaryRelation.get(n.id) ?? null;
                  drawGraphNode(n, ctx, globalScale, {
                    emphasized: n.id === hovered?.id,
                    subLabel: primary ? RELATION_LABELS[primary] : null,
                  });
                }}
                nodePointerAreaPaint={(
                  node: any,
                  color: string,
                  ctx: CanvasRenderingContext2D,
                  globalScale: number,
                ) => paintNodePointerArea(node as GraphNode, color, ctx, globalScale)}
                linkColor={(link: GraphLink) =>
                  `rgba(${hexToRgbTriplet(relationColor(link.label))}, 0.55)`
                }
                linkWidth={1.5}
                linkLineDash={[5, 4]}
                linkDirectionalArrowLength={12}
                linkDirectionalArrowRelPos={1}
                linkDirectionalArrowColor={(link: GraphLink) => relationColor(link.label)}
                onLinkClick={(link: GraphLink) => handleLinkClick(link)}
                onNodeHover={(node: GraphNode | null) => setHovered(node)}
                cooldownTicks={100}
                onEngineStop={() => {
                  if (didFitRef.current) return;
                  didFitRef.current = true;
                  // A `?q=` carried in a shared link supersedes the *initial*
                  // fit-to-screen, so the recipient lands on the same company the
                  // sender was zoomed into. Strictly once: this handler re-arms on
                  // every filter change (`didFitRef` is reset with each reheat), and
                  // re-applying the link's term on those later settles would yank the
                  // canvas back to it long after the user has edited or cleared the
                  // search box. Falls through to the fit when the term matches nothing
                  // in the current (filtered) graph.
                  if (!didInitialSearchRef.current) {
                    didInitialSearchRef.current = true;
                    if (initialFilters.search && runSearch(initialFilters.search)) return;
                  }
                  graphRef.current?.zoomToFit(500, 70);
                }}
                backgroundColor="transparent"
              />
            )}
          </div>
        </div>
      </div>

      {contextMenu && (
        <>
          {/* Full-screen catcher: any left-click outside the menu closes it. */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setContextMenu(null)} />
          <div
            className="fixed z-50 min-w-56 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <div className="truncate px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {contextMenu.node.name}
            </div>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-100"
              onClick={() => toggleConnectedOnly(contextMenu.node)}
            >
              <Check
                className={`h-3.5 w-3.5 shrink-0 ${connectedTo?.id === contextMenu.node.id ? 'opacity-100' : 'opacity-0'
                  }`}
              />
              Display only connected companies
            </button>
            {editMode && (
              <>
                <div className="mx-3 my-1 h-px bg-slate-100" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-100"
                  onClick={() => openNodeSize(contextMenu.node)}
                >
                  <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center text-[10px] font-bold text-slate-500">
                    {Math.round(nodeDisplaySize(contextMenu.node))}
                  </span>
                  Set node size
                </button>
              </>
            )}
            {editMode && contextMenu.node.pipelineStage === 'discovered' && (
              <>
                <div className="mx-3 my-1 h-px bg-slate-100" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                  onClick={() => openRemoveNode(contextMenu.node)}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  Remove node
                </button>
              </>
            )}
          </div>
        </>
      )}

      {selectedCompany && (
        <CompanyDetailDialog
          key={selectedCompany.id}
          company={selectedCompany}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onUpdate={() => { }}
        />
      )}

      {selectedLink && (
        <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                  style={{
                    background:
                      RELATION_COLORS[selectedLink.label as RelationType] ??
                      '#64748b',
                  }}
                />
                {RELATION_LABELS[selectedLink.label as RelationType] ??
                  selectedLink.label}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <span>{selectedLink.sourceName}</span>
                <span className="text-muted-foreground">&rarr;</span>
                <span>{selectedLink.targetName}</span>
              </div>
              {selectedLink.notes && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Notes
                  </p>
                  <p className="whitespace-pre-wrap break-words">{selectedLink.notes}</p>
                </div>
              )}
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Added
                </p>
                <p>
                  {selectedLink.date ? (
                    new Date(selectedLink.date).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })
                  ) : (
                    <span className="text-muted-foreground">Not recorded</span>
                  )}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Evidence
                </p>
                {selectedLink.evidence ? (
                  /^https?:\/\//.test(selectedLink.evidence) ? (
                    <a
                      href={selectedLink.evidence}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-blue-600 underline hover:text-blue-800"
                    >
                      {selectedLink.evidence}
                    </a>
                  ) : (
                    <p className="whitespace-pre-wrap break-words">
                      {selectedLink.evidence}
                    </p>
                  )
                ) : (
                  <p className="text-muted-foreground">No evidence recorded</p>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ─── Edit link dialog ─────────────────────────────────────────── */}
      {editingLink && (
        <Dialog open={editLinkOpen} onOpenChange={setEditLinkOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Edit Relationship</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              {/* Company endpoints */}
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">From</Label>
                  <NodeCombobox
                    nodes={sortedNodes}
                    value={editingLink.fromId}
                    onChange={(id) => setEditingLink((p) => p ? { ...p, fromId: id } : p)}
                  />
                </div>
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs gap-1 text-muted-foreground"
                    onClick={() =>
                      setEditingLink((p) =>
                        p ? { ...p, fromId: p.toId, toId: p.fromId } : p,
                      )
                    }
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    Swap direction
                  </Button>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">To</Label>
                  <NodeCombobox
                    nodes={sortedNodes}
                    value={editingLink.toId}
                    onChange={(id) => setEditingLink((p) => p ? { ...p, toId: id } : p)}
                  />
                </div>
              </div>

              {/* Type */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Type</Label>
                <Select
                  value={editingLink.type}
                  onValueChange={(v) =>
                    setEditingLink((p) => p ? { ...p, type: v as RelationType } : p)
                  }
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RELATION_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {RELATION_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Notes</Label>
                <Textarea
                  value={editingLink.notes}
                  onChange={(e) =>
                    setEditingLink((p) => p ? { ...p, notes: e.target.value } : p)
                  }
                  placeholder="Optional notes…"
                  className="h-20 text-sm resize-none"
                />
              </div>

              {/* Evidence */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Evidence</Label>
                <Input
                  value={editingLink.evidence}
                  onChange={(e) =>
                    setEditingLink((p) => p ? { ...p, evidence: e.target.value } : p)
                  }
                  placeholder="URL or description…"
                  className="h-8 text-sm"
                />
              </div>

              {/* Date */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Date</Label>
                <Input
                  type="date"
                  value={editingLink.date}
                  onChange={(e) =>
                    setEditingLink((p) => p ? { ...p, date: e.target.value } : p)
                  }
                  className="h-8 text-sm"
                />
              </div>
            </div>

            <DialogFooter className="flex-row justify-between sm:justify-between gap-2 pt-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleEditLinkDelete}
                disabled={editLinkDeleting || editLinkSaving}
              >
                {editLinkDeleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Delete
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditLinkOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleEditLinkSave}
                  disabled={editLinkSaving || editLinkDeleting}
                >
                  {editLinkSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ─── Node size dialog ────────────────────────────────────────── */}
      {nodeSizeTarget && (
        <Dialog open={nodeSizeOpen} onOpenChange={setNodeSizeOpen}>
          <DialogContent className="sm:max-w-xs">
            <DialogHeader>
              <DialogTitle>Node size — {nodeSizeTarget.name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              {nodeSizeTarget.ev != null ? (
                <p className="text-xs text-muted-foreground">
                  EV: ${(nodeSizeTarget.ev / 1000).toFixed(1)}B →{' '}
                  computed size{' '}
                  <span className="font-semibold text-foreground">
                    {evToDisplaySize(nodeSizeTarget.ev).toFixed(1)}
                  </span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No EV data recorded — default size is 3.
                </p>
              )}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Display size</Label>
                <Select
                  value={nodeSizeValue === null ? 'auto' : String(nodeSizeValue)}
                  onValueChange={(v) => setNodeSizeValue(v === 'auto' ? null : Number(v))}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (from EV)</SelectItem>
                    {[1, 2, 3, 4, 5].map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {s}{s === 3 ? ' (default)' : s === 1 ? ' — smallest' : s === 5 ? ' — largest' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter className="gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setNodeSizeOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleNodeSizeSave} disabled={nodeSizeSaving}>
                {nodeSizeSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ─── Remove node dialog ───────────────────────────────────────── */}
      {removeNodeTarget && (
        <Dialog open={removeNodeOpen} onOpenChange={setRemoveNodeOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Remove node</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <p>
                Remove <span className="font-semibold">{removeNodeTarget.name}</span> from the
                graph? This will also delete the company record.
              </p>

              {/* Reassign edges */}
              {(() => {
                const edgeCount = graphData.links.filter(
                  (l) =>
                    endpointId(l.source) === removeNodeTarget.id ||
                    endpointId(l.target) === removeNodeTarget.id,
                ).length;
                const replacementNodes = sortedNodes.filter((n) => n.id !== removeNodeTarget.id);
                return edgeCount > 0 ? (
                  <div className="space-y-2">
                    <p className="text-muted-foreground">
                      This node has{' '}
                      <span className="font-medium text-foreground">{edgeCount}</span>{' '}
                      {edgeCount === 1 ? 'connection' : 'connections'}.
                      {removeNodeReplacement
                        ? ' They will be reassigned to the selected company.'
                        : ' Leave blank to delete them, or select a company to reassign them.'}
                    </p>
                    <Label className="text-xs text-muted-foreground">Reassign edges to</Label>
                    <div className="flex gap-1.5 items-center">
                      <div className="flex-1">
                        <NodeCombobox
                          nodes={replacementNodes}
                          value={removeNodeReplacement}
                          onChange={setRemoveNodeReplacement}
                          placeholder="No reassignment (delete edges)"
                        />
                      </div>
                      {removeNodeReplacement && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 shrink-0 text-muted-foreground"
                          onClick={() => setRemoveNodeReplacement('')}
                          aria-label="Clear reassignment"
                        >
                          ✕
                        </Button>
                      )}
                    </div>
                  </div>
                ) : null;
              })()}
            </div>

            <DialogFooter className="flex-row justify-between sm:justify-between gap-2 pt-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleRemoveNode}
                disabled={removeNodeSaving}
              >
                {removeNodeSaving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Remove
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRemoveNodeOpen(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
