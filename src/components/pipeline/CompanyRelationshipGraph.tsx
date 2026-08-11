'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, Network, ArrowRight } from 'lucide-react';
// d3-force-3d is the force engine bundled with react-force-graph-2d; reusing it
// here keeps the snippet's forces consistent with the full graph page.
import { forceCollide, forceX, forceY } from 'd3-force-3d';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api/client';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import type {
  GraphData,
  GraphLink,
  GraphNode,
  RelationType,
} from '@/lib/repositories/companyRelationRepository';
import {
  RELATION_LABELS,
  drawGraphNode,
  endpointId,
  estimateNodeRadius,
  hexToRgbTriplet,
  nodeDisplaySize,
  nodeSizeFactor,
  paintNodePointerArea,
  primaryRelationByNode,
  relationColor,
  relationLabel,
} from '@/lib/graph/nodeStyle';

/**
 * Nodes are drawn at a constant on-screen size regardless of zoom, so the
 * miniature needs its own smaller scale to fit a handful of companies into a
 * card-sized canvas. Labels shrink with the circle, keeping proportions.
 */
const NODE_SCALE = 0.55;

/** Breathing room, in px, left around the fitted graph. */
const FIT_PADDING_PX = 18;

interface CompanyRelationshipGraphProps {
  companyId: string;
  /** Display name of the focal company, used in the empty-state copy. */
  companyName?: string;
}

/**
 * A read-only miniature of the relationship graph, scoped to one company and
 * the companies directly connected to it. Deliberately filter-free — the full
 * graph page owns filtering, reached via "Show in relationship graph", which
 * deep-links with this company already pinned to "connected companies only".
 */
export default function CompanyRelationshipGraph({
  companyId,
  companyName,
}: CompanyRelationshipGraphProps) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Force-graph touches `window`, so it is imported client-side only. Loading it
  // directly (rather than via next/dynamic) keeps the imperative ref intact.
  const [ForceGraph2D, setForceGraph2D] = useState<any>(null);
  const graphRef = useRef<any>(null);

  // The canvas is sized from the box it sits in rather than force-graph's
  // 800×600 default, which would overflow this compact card and push part of
  // the graph out of view.
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const graphHref = useWorkspaceHref('/graph');

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    import('react-force-graph-2d')
      .then((mod) => setForceGraph2D(() => mod.default))
      // Without this the canvas would sit on "Loading…" forever when the chunk
      // fails to load, since the data fetch resolves independently.
      .catch(() => setError('Failed to load the graph renderer'));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // apiRequest (not a raw fetch) so the request carries this tab's
    // `X-Workspace-Slug` — otherwise the route resolves the workspace from the
    // session cookie and a second tab on another workspace 404s.
    apiRequest<GraphData>(`/api/graph/connections?companyId=${encodeURIComponent(companyId)}`)
      .then((data) => {
        if (!cancelled) setGraphData(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load relationships');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Rebuild fresh node/link objects so force-graph's in-place mutation never
  // bleeds back into the fetched data.
  const displayData = useMemo<GraphData>(
    () => ({
      nodes: graphData.nodes.map((n) => ({ ...n, val: nodeDisplaySize(n) })),
      links: graphData.links.map((l) => {
        const source = endpointId(l.source);
        const target = endpointId(l.target);
        // INVESTED_IN is stored as investor(source) -> investee(target) but reads
        // the other way round on the canvas — swap so the arrow points correctly.
        const reversed = (l.label as RelationType) === 'INVESTED_IN';
        return { ...l, source: reversed ? target : source, target: reversed ? source : target };
      }),
    }),
    [graphData],
  );

  const nodePrimaryRelation = useMemo(
    () => primaryRelationByNode(displayData.links),
    [displayData],
  );

  // Relation types actually present, for the compact legend.
  const presentRelations = useMemo(() => {
    const seen = new Set<string>();
    for (const l of graphData.links) seen.add(l.label);
    return [...seen];
  }, [graphData.links]);

  const connectionCount = Math.max(0, displayData.nodes.length - 1);
  const ready = !loading && !error && ForceGraph2D && displayData.nodes.length > 0;

  // Force tuning mirrors the full graph, scaled down with the nodes so spacing
  // stays proportional in the smaller canvas.
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || !ready) return;

    const radiusOf = (n: GraphNode) => estimateNodeRadius(nodeSizeFactor(n), NODE_SCALE);
    fg.d3Force('collide', forceCollide((n: GraphNode) => radiusOf(n) + 8).strength(1));
    const linkForce = fg.d3Force('link');
    if (linkForce) {
      linkForce.distance((l: { source: GraphNode; target: GraphNode }) =>
        radiusOf(l.source) + radiusOf(l.target) + 45,
      );
    }
    const charge = fg.d3Force('charge');
    if (charge) charge.strength(-60).distanceMax(200);
    fg.d3Force('x', forceX(0).strength(0.1));
    fg.d3Force('y', forceY(0).strength(0.1));

    fg.d3ReheatSimulation();
  }, [ready, displayData]);

  // Keep the whole neighbourhood framed and centred: re-fit whenever the layout
  // settles or the box is resized (opening the dialog, a window resize). Panning
  // and zooming are disabled, so the fitted view is the only view.
  const fitToView = useCallback(() => {
    graphRef.current?.zoomToFit(0, FIT_PADDING_PX);
  }, []);

  useEffect(() => {
    if (!ready || dimensions.width === 0) return;
    fitToView();
  }, [ready, dimensions, displayData, fitToView]);

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Network className="h-3.5 w-3.5" />
            Relationships
          </p>
          {!loading && !error && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {connectionCount === 0
                ? 'No connected companies yet'
                : `${connectionCount} connected compan${connectionCount === 1 ? 'y' : 'ies'}`}
            </p>
          )}
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
          <Link href={`${graphHref}?connectedTo=${encodeURIComponent(companyId)}`}>
            Show in relationship graph
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      <div
        ref={containerRef}
        className="relative h-72 overflow-hidden rounded-md border border-sky-200/80"
        style={{
          backgroundColor: '#eaf2ff',
          backgroundImage:
            'radial-gradient(circle, rgba(99, 102, 241, 0.18) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      >
        {(loading || (!error && !ForceGraph2D)) && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading relationships…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-destructive">
            {error}
          </div>
        )}
        {!loading && !error && displayData.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {companyName ?? 'This company'} is not in the relationship graph yet.
          </div>
        )}
        {ready && dimensions.width > 0 && (
          <ForceGraph2D
            ref={graphRef}
            width={dimensions.width}
            height={dimensions.height}
            graphData={displayData}
            // Read-only miniature: the view is always the fitted, centred one,
            // so nothing here may drag, pan or zoom it out of frame.
            enableNodeDrag={false}
            enablePanInteraction={false}
            enableZoomInteraction={false}
            nodeId="id"
            nodeLabel="name"
            nodeVal="val"
            nodeRelSize={20}
            nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
              const n = node as GraphNode & { x?: number; y?: number };
              const primary = nodePrimaryRelation.get(n.id) ?? null;
              drawGraphNode(n, ctx, globalScale, {
                // The company being viewed is drawn stronger than its neighbours.
                emphasized: n.id === companyId,
                subLabel: primary ? RELATION_LABELS[primary] : null,
                scale: NODE_SCALE,
              });
            }}
            nodePointerAreaPaint={(
              node: any,
              color: string,
              ctx: CanvasRenderingContext2D,
              globalScale: number,
            ) => paintNodePointerArea(node as GraphNode, color, ctx, globalScale, NODE_SCALE)}
            linkColor={(link: GraphLink) =>
              `rgba(${hexToRgbTriplet(relationColor(link.label))}, 0.55)`
            }
            linkWidth={1.5}
            linkLineDash={[4, 3]}
            linkDirectionalArrowLength={8}
            linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={(link: GraphLink) => relationColor(link.label)}
            cooldownTicks={100}
            // Re-fit on every tick as well as at rest: the simulation spreads
            // nodes out as it settles, and fitting only at the end would let
            // them leave the frame in the meantime.
            onEngineTick={fitToView}
            onEngineStop={fitToView}
            backgroundColor="transparent"
          />
        )}
      </div>

      {presentRelations.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {presentRelations.map((label) => (
            <li key={label} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: relationColor(label) }}
              />
              <span className="text-[11px] text-muted-foreground">{relationLabel(label)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
