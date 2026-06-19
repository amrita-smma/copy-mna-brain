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
import { Check, Loader2, RefreshCw, Search } from 'lucide-react';
// d3-force-3d is the force engine bundled with react-force-graph-2d; reusing it
// here keeps our custom forces consistent with the graph's own simulation.
import { forceCollide, forceX, forceY } from 'd3-force-3d';
import { getCompanies } from '@/lib/api/pipeline';
import CompanyDetailDialog, {
  type CompanyData,
} from '@/components/pipeline/CompanyDetailDialog';
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

const SEGMENT_COLORS: Record<string, string> = {
  technology: '#6366f1',
  logistics: '#f59e0b',
  healthcare: '#10b981',
  finance: '#3b82f6',
  manufacturing: '#64748b',
  retail: '#ec4899',
};

function nodeColor(node: GraphNode): string {
  const seg = node.segment?.toLowerCase() ?? '';
  return SEGMENT_COLORS[seg] ?? '#94a3b8';
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

/** Compute the node radius that fits the name lines + the relationship sub-label. */
function getNodeRadius(
  ctx: CanvasRenderingContext2D,
  nameLines: string[],
  subLabel: string | null,
  globalScale: number,
): number {
  const nameFont = NODE_NAME_FONT_PX / globalScale;
  ctx.font = `700 ${nameFont}px sans-serif`;
  let maxWidth = nameLines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
  let totalHeight = nameLines.length * (NODE_NAME_LINE_HEIGHT_PX / globalScale);

  if (subLabel) {
    const subFont = NODE_SUBLABEL_FONT_PX / globalScale;
    ctx.font = `600 ${subFont}px sans-serif`;
    maxWidth = Math.max(maxWidth, ctx.measureText(subLabel).width);
    totalHeight += (NODE_SUBLABEL_GAP_PX + NODE_SUBLABEL_FONT_PX) / globalScale;
  }

  const pad = NODE_LABEL_PADDING_PX / globalScale;
  const textHalfWidth = maxWidth / 2 + pad;
  const textHalfHeight = totalHeight / 2 + pad;
  const minRadius = NODE_MIN_RADIUS_PX / globalScale;
  return Math.max(minRadius, textHalfWidth, textHalfHeight);
}

/**
 * Estimate a node's drawn radius (in px) without a canvas context, used to size
 * the collision + link-distance forces so nodes don't overlap and edges stay
 * visible. Mirrors the layout logic in `getNodeRadius`.
 */
function estimateNodeRadius(name: string, hasSubLabel: boolean): number {
  const lines = toUpperLabelLines(name);
  const longest = lines.reduce((max, l) => Math.max(max, l.length), 0);
  // ~0.62em per char for bold sans-serif at our font size.
  const approxWidth = longest * NODE_NAME_FONT_PX * 0.62;
  let approxHeight = lines.length * NODE_NAME_LINE_HEIGHT_PX;
  if (hasSubLabel) approxHeight += NODE_SUBLABEL_GAP_PX + NODE_SUBLABEL_FONT_PX;
  const halfW = approxWidth / 2 + NODE_LABEL_PADDING_PX;
  const halfH = approxHeight / 2 + NODE_LABEL_PADDING_PX;
  return Math.max(NODE_MIN_RADIUS_PX, halfW, halfH);
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
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({
        source: endpointId(l.source),
        target: endpointId(l.target),
        label: l.label,
        evidence: l.evidence,
        date: l.date,
      })),
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

  // Tune the force simulation so connected nodes get enough breathing room for
  // their edges to read clearly, while disconnected sub-graphs stay grouped
  // toward the centre rather than drifting to the corners.
  const didFitRef = useRef(false);
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || !ForceGraph2D) return;

    const radiusOf = (n: GraphNode) =>
      estimateNodeRadius(n.name, nodePrimaryRelation.has(n.id));

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

  const handleNodeClick = async (node: GraphNode) => {
    try {
      const company = await getCompanies({ id: node.id });
      if (company) {
        setSelectedCompany(company as CompanyData);
        setDialogOpen(true);
        return;
      }
    } catch (err) {
      console.error('Failed to load company details', err);
    }
    // Fall back to the node's own attributes for seed/demo data that has no
    // matching Postgres company row.
    setSelectedCompany(fallbackCompany(node));
    setDialogOpen(true);
  };

  const handleNodeRightClick = (node: GraphNode, event: MouseEvent) => {
    event.preventDefault();
    setContextMenu({ node, x: event.clientX, y: event.clientY });
  };

  // Toggle the "connected only" filter for the right-clicked node. Selecting a
  // new node pins it; re-selecting the already-pinned node removes the filter.
  const toggleConnectedOnly = (node: GraphNode) => {
    setConnectedTo((prev) => (prev?.id === node.id ? null : node));
    setContextMenu(null);
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
              <h1 className="text-lg font-bold tracking-tight">Relationship Graph</h1>
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
                <ul className="space-y-1.5 mb-3">
                  {RELATION_TYPES.map((type) => (
                    <li key={`legend-${type}`} className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: RELATION_COLORS[type] }}
                      />
                      <span className="text-[11px] tracking-wide text-black uppercase">
                        {RELATION_LABELS[type]}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="pt-2 border-t border-slate-300/80">
                  <p className="text-[11px] tracking-wide text-black uppercase">Arrows: Source &rarr; Target</p>
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
                  const r = getNodeRadius(ctx, lines, subLabel, globalScale);

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

                  // Company name (bold, uppercase, dark).
                  const nameFont = NODE_NAME_FONT_PX / globalScale;
                  const lineHeight = NODE_NAME_LINE_HEIGHT_PX / globalScale;
                  const subFont = NODE_SUBLABEL_FONT_PX / globalScale;
                  const subGap = NODE_SUBLABEL_GAP_PX / globalScale;
                  const subBlock = subLabel ? subGap + subFont : 0;
                  const totalHeight = lines.length * lineHeight + subBlock;
                  let cursorY = y - totalHeight / 2 + lineHeight / 2;

                  ctx.font = `700 ${nameFont}px sans-serif`;
                  ctx.fillStyle = '#0f172a';
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  for (const line of lines) {
                    ctx.fillText(line, x, cursorY);
                    cursorY += lineHeight;
                  }

                  // Relationship sub-label (colored to match the node).
                  if (subLabel) {
                    cursorY = cursorY - lineHeight + lineHeight / 2 + subGap + subFont / 2;
                    ctx.font = `600 ${subFont}px sans-serif`;
                    ctx.fillStyle = color;
                    ctx.fillText(subLabel, x, cursorY);
                  }
                }}
                nodePointerAreaPaint={(
                  node: any,
                  color: string,
                  ctx: CanvasRenderingContext2D,
                  globalScale: number,
                ) => {
                  const n = node as GraphNode & { x?: number; y?: number };
                  const primary = nodePrimaryRelation.get(n.id) ?? null;
                  const subLabel = primary ? RELATION_LABELS[primary] : null;
                  const lines = toUpperLabelLines(n.name);
                  const r = getNodeRadius(ctx, lines, subLabel, globalScale);
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
          </div>
        </>
      )}

      {selectedCompany && (
        <CompanyDetailDialog
          company={selectedCompany}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onUpdate={() => {}}
        />
      )}
    </DashboardLayout>
  );
}
