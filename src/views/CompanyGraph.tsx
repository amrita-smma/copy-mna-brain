'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
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
import { ArrowLeftRight, Check, Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
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

const RELATION_COLORS: Record<RelationType, string> = {
  INVESTED_IN: '#3b82f6',
  PARTNER: '#22c55e',
  SUPPLIER: '#f59e0b',
};

const RELATION_LABELS: Record<RelationType, string> = {
  INVESTED_IN: 'Invested in',
  PARTNER: 'Partner',
  SUPPLIER: 'Supplier',
};

const RELATION_TYPES = Object.keys(RELATION_COLORS) as RelationType[];

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

// Sentinel filter value for companies that have no relationships at all.
const NO_RELATION = 'NONE' as const;
type RelationFilter = RelationType | typeof NO_RELATION;

const NO_RELATION_COLOR = '#94a3b8';
const NO_RELATION_LABEL = 'No relationship';

// Sentinel filter value for companies with no pipeline stage recorded on the
// graph node (e.g. seed/demo data synced before the field existed).
const NO_STAGE = '__none__' as const;

const PIPELINE_STAGE_LABELS: Record<string, string> = {
  market_screening: 'Market Screening',
  L0: 'L0',
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  L4: 'L4',
  L5: 'L5',
  discovered: 'Discovered',
};

function pipelineStageLabel(stage: string): string {
  if (stage === NO_STAGE) return 'No stage';
  return PIPELINE_STAGE_LABELS[stage] ?? stage;
}

type StatusFilter = 'all' | 'active' | 'dropped';

const STAGE_COLOR_GREY = '#94a3b8';   // discovered
const STAGE_COLOR_YELLOW = '#eab308'; // market_screening / no stage
const STAGE_COLOR_BLUE = '#3b82f6';   // L0–L5

function nodeColor(node: GraphNode): string {
  const stage = node.pipelineStage;
  if (!stage || stage === 'market_screening') return STAGE_COLOR_YELLOW;
  if (stage === 'discovered') return STAGE_COLOR_GREY;
  if (/^L[0-5]$/.test(stage)) return STAGE_COLOR_BLUE;
  return STAGE_COLOR_GREY;
}

// ─── EV-based node sizing ─────────────────────────────────────────────────────

/**
 * Map enterprise value (USD millions) to a 1–5 display size using a log scale.
 * ≤ $1B → 1, ≥ $100B → 5, log-interpolated in between.
 */
function evToDisplaySize(evMn: number): number {
  if (evMn <= 1000) return 1;
  if (evMn >= 100000) return 5;
  // log10(1000) = 3, log10(100000) = 5 → scale 1–5 across that 2-decade range
  return 1 + ((Math.log10(evMn) - 3) / 2) * 4;
}

/** Resolved 1–5 display size: override beats EV-computed, fallback is 3. */
function nodeDisplaySize(node: GraphNode): number {
  if (node.graphSizeOverride != null) return node.graphSizeOverride;
  if (node.ev != null) return evToDisplaySize(node.ev);
  return 3;
}

/**
 * Radius multiplier — size 1 is the baseline (1×) and each step is 1.3× the previous.
 * size 1 → 1.00×  size 2 → 1.30×  size 3 → 1.69×  size 4 → 2.20×  size 5 → 2.86×
 */
function nodeSizeFactor(node: GraphNode): number {
  return Math.pow(1.3, nodeDisplaySize(node) - 1);
}

const NODE_MIN_RADIUS_PX = 38;
const NODE_NAME_FONT_PX = 13;
const NODE_NAME_LINE_HEIGHT_PX = 14;
const NODE_SUBLABEL_FONT_PX = 9.5;
const NODE_SUBLABEL_GAP_PX = 7;
const NODE_LABEL_MAX_CHARS = 12;
const NODE_LABEL_MAX_LINES = 3;
const NODE_LABEL_PADDING_PX = 13;

function toUpperLabelLines(name: string): string[] {
  const label = name.trim().toUpperCase();
  if (!label) return ['UNKNOWN'];

  const words = label.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= NODE_LABEL_MAX_CHARS) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);

  if (lines.length <= NODE_LABEL_MAX_LINES) return lines;
  const limited = lines.slice(0, NODE_LABEL_MAX_LINES);
  const last = limited[NODE_LABEL_MAX_LINES - 1];
  limited[NODE_LABEL_MAX_LINES - 1] =
    last.length > NODE_LABEL_MAX_CHARS - 3
      ? `${last.slice(0, NODE_LABEL_MAX_CHARS - 3)}...`
      : `${last}...`;
  return limited;
}

/** Node radius in canvas units — determined by size factor only; text fits within. */
function getNodeRadius(globalScale: number, sizeFactor: number): number {
  return (NODE_MIN_RADIUS_PX * sizeFactor) / globalScale;
}

/** Estimated radius in screen px — used by the force simulation. Matches getNodeRadius at globalScale = 1. */
function estimateNodeRadius(sizeFactor: number): number {
  return NODE_MIN_RADIUS_PX * sizeFactor;
}

/**
 * Truncate `text` so it fits within `maxWidth` canvas units, appending "…".
 * Returns an empty string when even the ellipsis alone doesn't fit.
 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || !text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 0 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s.length > 0 ? s + '…' : '';
}

/** Convert a #rrggbb hex string to an `r, g, b` triplet for rgba() usage. */
function hexToRgbTriplet(hex: string): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

/** Resolve a link endpoint to its node id (force-graph mutates strings to node refs). */
function endpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'object' ? endpoint.id : endpoint;
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
  showCompanyGraph?: boolean;
}

export default function CompanyGraph({
  showCompanyGraph = false,
}: CompanyGraphProps) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
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
  const [search, setSearch] = useState('');
  const [ownership, setOwnership] = useState<'all' | Ownership>('all');
  const [geography, setGeography] = useState<string>('all');
  const [pipelineStage, setPipelineStage] = useState<string>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [enabledTypes, setEnabledTypes] = useState<Set<RelationFilter>>(
    () => new Set<RelationFilter>([...RELATION_TYPES, NO_RELATION]),
  );
  const [hasEvidenceOnly, setHasEvidenceOnly] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

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
    const order = Object.keys(PIPELINE_STAGE_LABELS);
    const sorted = Array.from(set).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return hasMissing ? [...sorted, NO_STAGE] : sorted;
  }, [graphData.nodes]);

  // When a "connected only" node is pinned, the set of node ids allowed through
  // the filter: the node itself plus every company sharing an edge with it.
  // Derived from the full (unfiltered) link set so it's an intrinsic neighbour
  // relation, independent of the active edge-type filters.
  const connectedIds = useMemo(() => {
    if (!connectedTo) return null;
    const ids = new Set<string>([connectedTo.id]);
    for (const l of graphData.links) {
      const s = endpointId(l.source);
      const t = endpointId(l.target);
      if (s === connectedTo.id) ids.add(t);
      if (t === connectedTo.id) ids.add(s);
    }
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

  // Apply node + edge filters. Rebuilds fresh node/link objects so force-graph's
  // in-place mutation never bleeds back into the raw data. Excludes `hovered`
  // from deps so hovering doesn't restart the simulation.
  const filteredData = useMemo<GraphData>(() => {
    const nodes = graphData.nodes.filter((n) => {
      if (ownership !== 'all' && n.ownership !== ownership) return false;
      if (geography !== 'all' && n.geography !== geography) return false;
      if (pipelineStage !== 'all') {
        const stage = n.pipelineStage ?? NO_STAGE;
        if (stage !== pipelineStage) return false;
      }
      if (status !== 'all' && n.status !== status) return false;
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
  }, [graphData, ownership, geography, pipelineStage, status, connectedIds, enabledTypes, hasEvidenceOnly, dateFrom, dateTo, nodeCharacteristics]);

  // Each node's dominant relationship type (most frequent incident edge label),
  // used for the small sub-label rendered inside the circle. Tie-break follows
  // the canonical RELATION_TYPES order.
  const nodePrimaryRelation = useMemo(() => {
    const counts = new Map<string, Map<RelationType, number>>();
    for (const l of filteredData.links) {
      const type = l.label as RelationType;
      if (!RELATION_COLORS[type]) continue;
      for (const id of [endpointId(l.source), endpointId(l.target)]) {
        const m = counts.get(id) ?? new Map<RelationType, number>();
        m.set(type, (m.get(type) ?? 0) + 1);
        counts.set(id, m);
      }
    }
    const primary = new Map<string, RelationType>();
    for (const [id, m] of counts) {
      let best: RelationType | null = null;
      let bestCount = -1;
      for (const type of RELATION_TYPES) {
        const c = m.get(type) ?? 0;
        if (c > bestCount) {
          best = type;
          bestCount = c;
        }
      }
      if (best) primary.set(id, best);
    }
    return primary;
  }, [filteredData]);

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

  const handleSearch = () => {
    const q = search.trim().toLowerCase();
    if (!q || !graphRef.current) return;
    const match =
      filteredData.nodes.find((n) => n.name.toLowerCase() === q) ??
      filteredData.nodes.find((n) => n.name.toLowerCase().includes(q));
    if (!match) return;
    const n = match as GraphNode & { x?: number; y?: number };
    graphRef.current.centerAt(n.x ?? 0, n.y ?? 0, 800);
    graphRef.current.zoom(5, 800);
    setHovered(match);
  };

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

  // Resolve an endpoint (string id or mutated node ref) to its company name.
  const nodeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of graphData.nodes) map.set(n.id, n.name);
    return map;
  }, [graphData.nodes]);

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
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
      <div className="flex flex-col h-full">
        <div className="flex flex-1 min-h-0 gap-4 p-4">
          {/* Filters + legend */}
          <aside className="w-64 shrink-0 space-y-5 overflow-y-auto pr-1">
            {/* Title */}
            <div>
              <div className="flex items-center justify-between">
                <h1 className="text-lg font-bold tracking-tight">Relationship Graph</h1>
                <Button
                  variant={editMode ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => setEditMode((v) => !v)}
                >
                  <Pencil className="h-3 w-3" />
                  {editMode ? 'Editing' : 'Edit'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
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
              <div className="space-y-3 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/60 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-indigo-900 uppercase tracking-wider">
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
              <div className="space-y-3 rounded-lg border border-dashed border-violet-300 bg-violet-50/60 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-violet-900 uppercase tracking-wider">
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

            {/* Company filters */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Companies
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Ownership</Label>
                <Select
                  value={ownership}
                  onValueChange={(v) => setOwnership(v as 'all' | Ownership)}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All companies</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Geography</Label>
                <Select value={geography} onValueChange={setGeography}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All geographies</SelectItem>
                    {geographies.map((g) => (
                      <SelectItem key={g} value={g}>
                        {g}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Pipeline stage</Label>
                <Select value={pipelineStage} onValueChange={setPipelineStage}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All stages</SelectItem>
                    {pipelineStages.map((s) => (
                      <SelectItem key={s} value={s}>
                        {pipelineStageLabel(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Active &amp; dropped</SelectItem>
                    <SelectItem value="active">Active only</SelectItem>
                    <SelectItem value="dropped">Dropped only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {connectedTo && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5">
                  <span className="text-[11px] leading-tight text-indigo-900">
                    Connected to{' '}
                    <span className="font-semibold">{connectedTo.name}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[11px] text-indigo-700 hover:text-indigo-900"
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
                    [STAGE_COLOR_YELLOW, 'Market Screening / No stage'],
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
              <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 rounded-full border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-[11px] font-semibold text-indigo-800 shadow-sm">
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
                  const x = n.x ?? 0;
                  const y = n.y ?? 0;
                  const isHovered = n.id === hovered?.id;
                  const color = nodeColor(n);
                  const rgb = hexToRgbTriplet(color);
                  const primary = nodePrimaryRelation.get(n.id) ?? null;
                  const subLabel = primary ? RELATION_LABELS[primary] : null;
                  const lines = toUpperLabelLines(n.name);
                  const sf = nodeSizeFactor(n);
                  const r = getNodeRadius(globalScale, sf);

                  // Soft drop shadow under a white base so the tint stays clean.
                  ctx.save();
                  ctx.beginPath();
                  ctx.arc(x, y, r, 0, 2 * Math.PI);
                  ctx.fillStyle = '#ffffff';
                  ctx.shadowColor = `rgba(${rgb}, ${isHovered ? 0.5 : 0.32})`;
                  ctx.shadowBlur = (isHovered ? 22 : 14) / globalScale;
                  ctx.shadowOffsetY = 4 / globalScale;
                  ctx.fill();
                  ctx.restore();

                  // Pastel tint fill.
                  ctx.beginPath();
                  ctx.arc(x, y, r, 0, 2 * Math.PI);
                  ctx.fillStyle = `rgba(${rgb}, ${isHovered ? 0.28 : 0.18})`;
                  ctx.fill();

                  // Colored ring.
                  ctx.beginPath();
                  ctx.arc(x, y, r, 0, 2 * Math.PI);
                  ctx.lineWidth = (isHovered ? 3 : 2) / globalScale;
                  ctx.strokeStyle = color;
                  ctx.stroke();

                  // Text layout within the fixed-size circle.
                  // Padding scales down proportionally for small nodes so there
                  // is always usable interior space.
                  const pad = Math.min(NODE_LABEL_PADDING_PX, r * globalScale * 0.4) / globalScale;
                  const innerW = Math.max(0, 2 * (r - pad));
                  const innerH = Math.max(0, 2 * (r - pad));

                  const nameFont = NODE_NAME_FONT_PX / globalScale;
                  const lineHeight = NODE_NAME_LINE_HEIGHT_PX / globalScale;
                  const subFont = NODE_SUBLABEL_FONT_PX / globalScale;
                  const subGap = NODE_SUBLABEL_GAP_PX / globalScale;

                  // Truncate each line to fit the node width.
                  ctx.font = `700 ${nameFont}px sans-serif`;
                  const fittedLines = lines.map((l) => fitText(ctx, l, innerW));

                  // Drop sublabel then lines until the text block fits vertically.
                  let showSub = subLabel !== null;
                  let nLines = fittedLines.length;
                  while (nLines > 0) {
                    const h = nLines * lineHeight + (showSub ? subGap + subFont : 0);
                    if (h <= innerH) break;
                    if (showSub) { showSub = false; } else { nLines--; }
                  }
                  const visibleLines = fittedLines.slice(0, nLines);

                  const totalHeight = visibleLines.length * lineHeight + (showSub ? subGap + subFont : 0);
                  let cursorY = y - totalHeight / 2 + lineHeight / 2;

                  ctx.fillStyle = '#0f172a';
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  for (const line of visibleLines) {
                    ctx.fillText(line, x, cursorY);
                    cursorY += lineHeight;
                  }

                  // Relationship sub-label (colored to match the node).
                  if (showSub && subLabel) {
                    cursorY = cursorY - lineHeight + lineHeight / 2 + subGap + subFont / 2;
                    ctx.font = `600 ${subFont}px sans-serif`;
                    ctx.fillStyle = color;
                    ctx.fillText(fitText(ctx, subLabel, innerW), x, cursorY);
                  }
                }}
                nodePointerAreaPaint={(
                  node: any,
                  color: string,
                  ctx: CanvasRenderingContext2D,
                  globalScale: number,
                ) => {
                  const n = node as GraphNode & { x?: number; y?: number };
                  const r = getNodeRadius(globalScale, nodeSizeFactor(n));
                  const x = n.x ?? 0;
                  const y = n.y ?? 0;
                  ctx.fillStyle = color;
                  ctx.beginPath();
                  ctx.arc(x, y, r, 0, 2 * Math.PI, false);
                  ctx.fill();
                }}
                linkColor={(link: GraphLink) => {
                  const base = RELATION_COLORS[link.label as RelationType] ?? '#64748b';
                  return `rgba(${hexToRgbTriplet(base)}, 0.55)`;
                }}
                linkWidth={1.5}
                linkLineDash={[5, 4]}
                linkDirectionalArrowLength={12}
                linkDirectionalArrowRelPos={1}
                linkDirectionalArrowColor={(link: GraphLink) =>
                  RELATION_COLORS[link.label as RelationType] ?? '#64748b'
                }
                onLinkClick={(link: GraphLink) => handleLinkClick(link)}
                onNodeHover={(node: GraphNode | null) => setHovered(node)}
                cooldownTicks={100}
                onEngineStop={() => {
                  if (didFitRef.current) return;
                  didFitRef.current = true;
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
                className={`h-3.5 w-3.5 shrink-0 ${
                  connectedTo?.id === contextMenu.node.id ? 'opacity-100' : 'opacity-0'
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
          onUpdate={() => {}}
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
                      className="break-all text-indigo-600 underline hover:text-indigo-800"
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
    </DashboardLayout>
  );
}
