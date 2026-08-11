import type { GraphNode, RelationType } from '@/lib/repositories/companyRelationRepository';

/**
 * Shared presentation layer for the company relationship graph — colours,
 * sizing, label layout and the canvas painter. Used by the full graph page
 * (`views/CompanyGraph`) and the relationship snippet on the company detail
 * page (`components/pipeline/CompanyRelationshipGraph`) so both canvases read
 * identically.
 */

export const RELATION_COLORS: Record<RelationType, string> = {
  INVESTED_IN: '#3b82f6',
  PARTNER: '#22c55e',
  SELLS_TO: '#f59e0b',
  SUPPLIER: '#f59e0b', // legacy — same colour as SELLS_TO
};

export const RELATION_LABELS: Record<RelationType, string> = {
  INVESTED_IN: 'Invested in',
  PARTNER: 'Partner',
  SELLS_TO: 'Sells to',
  SUPPLIER: 'Supplier', // legacy
};

export const RELATION_TYPES = Object.keys(RELATION_COLORS) as RelationType[];

/** Fallback edge colour for a relation type the UI doesn't know about. */
export const UNKNOWN_RELATION_COLOR = '#64748b';

export const STAGE_COLOR_GREY = '#94a3b8'; // discovered
export const STAGE_COLOR_YELLOW = '#eab308'; // market_screening / no stage
export const STAGE_COLOR_BLUE = '#3b82f6'; // L0–L5

/** Node colour by pipeline stage. */
export function nodeColor(node: GraphNode): string {
  const stage = node.pipelineStage;
  if (!stage || stage === 'market_screening' || stage === 'unreviewed') return STAGE_COLOR_YELLOW;
  if (stage === 'discovered') return STAGE_COLOR_GREY;
  if (/^L[0-5]$/.test(stage)) return STAGE_COLOR_BLUE;
  return STAGE_COLOR_GREY;
}

// ─── EV-based node sizing ─────────────────────────────────────────────────────

/**
 * Map enterprise value (USD millions) to a 1–5 display size using a log scale.
 * ≤ $1B → 1, ≥ $100B → 5, log-interpolated in between.
 */
export function evToDisplaySize(evMn: number): number {
  if (evMn <= 1000) return 1;
  if (evMn >= 100000) return 5;
  // log10(1000) = 3, log10(100000) = 5 → scale 1–5 across that 2-decade range
  return 1 + ((Math.log10(evMn) - 3) / 2) * 4;
}

/** Resolved 1–5 display size: override beats EV-computed, fallback is 3. */
export function nodeDisplaySize(node: GraphNode): number {
  if (node.graphSizeOverride != null) return node.graphSizeOverride;
  if (node.ev != null) return evToDisplaySize(node.ev);
  return 3;
}

/**
 * Radius multiplier — size 1 is the baseline (1×) and each step is 1.3× the previous.
 * size 1 → 1.00×  size 2 → 1.30×  size 3 → 1.69×  size 4 → 2.20×  size 5 → 2.86×
 */
export function nodeSizeFactor(node: GraphNode): number {
  return Math.pow(1.3, nodeDisplaySize(node) - 1);
}

export const NODE_MIN_RADIUS_PX = 38;
const NODE_NAME_FONT_PX = 13;
const NODE_NAME_LINE_HEIGHT_PX = 14;
const NODE_SUBLABEL_FONT_PX = 9.5;
const NODE_SUBLABEL_GAP_PX = 7;
const NODE_LABEL_MAX_CHARS = 12;
const NODE_LABEL_MAX_LINES = 3;
const NODE_LABEL_PADDING_PX = 13;

/** Wrap an upper-cased company name into at most 3 short, ellipsised lines. */
export function toUpperLabelLines(name: string): string[] {
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

/**
 * Node radius in canvas units — determined by size factor only; text fits
 * within. Dividing by `globalScale` makes the drawn node a constant size on
 * screen at any zoom level. `scale` shrinks (or grows) the whole node uniformly
 * — labels included — so a compact canvas can render the same graph smaller.
 */
export function getNodeRadius(globalScale: number, sizeFactor: number, scale = 1): number {
  return (NODE_MIN_RADIUS_PX * sizeFactor * scale) / globalScale;
}

/** Estimated radius in screen px — used by the force simulation. Matches getNodeRadius at globalScale = 1. */
export function estimateNodeRadius(sizeFactor: number, scale = 1): number {
  return NODE_MIN_RADIUS_PX * sizeFactor * scale;
}

/**
 * Truncate `text` so it fits within `maxWidth` canvas units, appending "…".
 * Returns an empty string when even the ellipsis alone doesn't fit.
 */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || !text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 0 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s.length > 0 ? s + '…' : '';
}

/** Convert a #rrggbb hex string to an `r, g, b` triplet for rgba() usage. */
export function hexToRgbTriplet(hex: string): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

/** Resolve a link endpoint to its node id (force-graph mutates strings to node refs). */
export function endpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'object' ? endpoint.id : endpoint;
}

/** Edge colour for a relation label, falling back to slate for unknown types. */
export function relationColor(label: string): string {
  return RELATION_COLORS[label as RelationType] ?? UNKNOWN_RELATION_COLOR;
}

/** Human-readable name for a relation label, falling back to the raw label. */
export function relationLabel(label: string): string {
  return RELATION_LABELS[label as RelationType] ?? label;
}

/**
 * Each node's dominant relationship type (its most frequent incident edge
 * label), used for the small sub-label rendered inside the circle. Ties break
 * on the canonical `RELATION_TYPES` order. Nodes with no known relation type
 * are absent from the map.
 */
export function primaryRelationByNode(
  links: Array<{ source: string | GraphNode; target: string | GraphNode; label: string }>,
): Map<string, RelationType> {
  const counts = new Map<string, Map<RelationType, number>>();
  for (const l of links) {
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
}

/**
 * Paint one company node: tinted circle with a coloured ring, the wrapped
 * company name, and an optional relationship sub-label. `emphasized` gives the
 * node a stronger shadow/ring (used for hover, and for the focal company in the
 * detail-page snippet). `scale` shrinks the circle and every text metric
 * together, so a smaller node keeps the same proportions instead of losing its
 * label to truncation.
 */
export function drawGraphNode(
  node: GraphNode & { x?: number; y?: number },
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  options: { emphasized?: boolean; subLabel?: string | null; scale?: number } = {},
): void {
  const { emphasized = false, subLabel = null, scale = 1 } = options;
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const color = nodeColor(node);
  const rgb = hexToRgbTriplet(color);
  const lines = toUpperLabelLines(node.name);
  const r = getNodeRadius(globalScale, nodeSizeFactor(node), scale);

  // Soft drop shadow under a white base so the tint stays clean.
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = `rgba(${rgb}, ${emphasized ? 0.5 : 0.32})`;
  ctx.shadowBlur = (emphasized ? 22 : 14) / globalScale;
  ctx.shadowOffsetY = 4 / globalScale;
  ctx.fill();
  ctx.restore();

  // Pastel tint fill.
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = `rgba(${rgb}, ${emphasized ? 0.28 : 0.18})`;
  ctx.fill();

  // Colored ring.
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.lineWidth = (emphasized ? 3 : 2) / globalScale;
  ctx.strokeStyle = color;
  ctx.stroke();

  // Text layout within the fixed-size circle. Padding scales down
  // proportionally for small nodes so there is always usable interior space.
  const pad = Math.min(NODE_LABEL_PADDING_PX * scale, r * globalScale * 0.4) / globalScale;
  const innerW = Math.max(0, 2 * (r - pad));
  const innerH = Math.max(0, 2 * (r - pad));

  const nameFont = (NODE_NAME_FONT_PX * scale) / globalScale;
  const lineHeight = (NODE_NAME_LINE_HEIGHT_PX * scale) / globalScale;
  const subFont = (NODE_SUBLABEL_FONT_PX * scale) / globalScale;
  const subGap = (NODE_SUBLABEL_GAP_PX * scale) / globalScale;

  // Truncate each line to fit the node width.
  ctx.font = `700 ${nameFont}px sans-serif`;
  const fittedLines = lines.map((l) => fitText(ctx, l, innerW));

  // Drop sublabel then lines until the text block fits vertically.
  let showSub = subLabel !== null;
  let nLines = fittedLines.length;
  while (nLines > 0) {
    const h = nLines * lineHeight + (showSub ? subGap + subFont : 0);
    if (h <= innerH) break;
    if (showSub) {
      showSub = false;
    } else {
      nLines--;
    }
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
}

/** Hit-area painter for force-graph's pointer layer — a plain filled circle. */
export function paintNodePointerArea(
  node: GraphNode & { x?: number; y?: number },
  color: string,
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  scale = 1,
): void {
  const r = getNodeRadius(globalScale, nodeSizeFactor(node), scale);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI, false);
  ctx.fill();
}
