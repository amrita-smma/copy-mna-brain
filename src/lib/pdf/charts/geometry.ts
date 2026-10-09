/**
 * Pure chart geometry: data in, pixel coordinates out.
 *
 * Nothing here touches React or the PDF primitives, which is what lets the
 * arithmetic that used to produce colliding bar labels be unit-tested directly.
 * `Chart.tsx` is a thin translation of these numbers into `<Svg>` elements.
 *
 * The coordinate system is SVG's: y grows downward from the top-left of the
 * plot box.
 */
import { buildTicks, formatCompact, truncateLabel, type AxisTicks } from '../format';

export type ChartType = 'bar' | 'stacked_bar' | 'line' | 'pie';

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: ChartType;
  /** X-axis category labels. Pie charts use one slice per category. */
  categories: string[];
  series: ChartSeries[];
  unit?: string;
}

export interface ChartBox {
  width: number;
  height: number;
}

/** Surface gap between adjacent stacked segments, in points. */
export const STACK_GAP = 1.2;

/** Room reserved around the plot for tick labels and category labels. */
const PAD = { top: 10, right: 6, bottom: 20, left: 34 } as const;

/** Approximate advance width of Inter at a given size — enough for collision tests. */
export const CHAR_WIDTH_RATIO = 0.55;

export function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_WIDTH_RATIO;
}

export interface PlotFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridLine {
  y: number;
  value: number;
  label: string;
  isZero: boolean;
}

export interface BarMark {
  seriesIndex: number;
  categoryIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  /** Direct label, or null when it would collide with a neighbour's. */
  label: string | null;
  labelX: number;
  labelY: number;
}

export interface PointMark {
  seriesIndex: number;
  categoryIndex: number;
  x: number;
  y: number;
  value: number;
}

export interface LineMark {
  seriesIndex: number;
  points: PointMark[];
}

export interface SliceMark {
  categoryIndex: number;
  /** SVG path for the wedge. */
  path: string;
  value: number;
  percent: number;
  label: string;
}

export interface CategoryLabel {
  x: number;
  text: string;
}

export interface ChartGeometry {
  plot: PlotFrame;
  ticks: AxisTicks;
  gridLines: GridLine[];
  categoryLabels: CategoryLabel[];
  bars: BarMark[];
  lines: LineMark[];
  slices: SliceMark[];
  /** Series names in slot order — the caller renders these as the legend. */
  legend: string[];
}

/** Flatten every plotted value, treating a stacked chart's column totals as one value. */
function domainValues(spec: ChartSpec): number[] {
  if (spec.type === 'stacked_bar') {
    // Matches the segment filter below: only positive values are stacked, so
    // only they may set the axis maximum.
    return spec.categories.map((_, i) =>
      spec.series.reduce((sum, s) => {
        const v = s.values[i] ?? 0;
        return Number.isFinite(v) && v > 0 ? sum + v : sum;
      }, 0),
    );
  }
  return spec.series.flatMap((s) => s.values.filter((v) => Number.isFinite(v)));
}

/**
 * Build the geometry for one chart.
 *
 * Direct value labels are emitted only where they fit: `label` is `null` when
 * the text would be wider than the bar's slot, which is exactly the case the
 * old renderer drew anyway and that produced overlapping numbers at twelve
 * data points.
 */
export function buildChartGeometry(
  spec: ChartSpec,
  box: ChartBox,
  labelFontSize = 6.5,
): ChartGeometry {
  const legend = spec.series.map((s) => s.name);

  if (spec.type === 'pie') {
    return {
      plot: { x: 0, y: 0, width: box.width, height: box.height },
      ticks: { min: 0, max: 0, step: 1, values: [] },
      gridLines: [],
      categoryLabels: [],
      bars: [],
      lines: [],
      slices: buildPieSlices(spec, box),
      legend: spec.categories,
    };
  }

  const plot: PlotFrame = {
    x: PAD.left,
    y: PAD.top,
    width: Math.max(10, box.width - PAD.left - PAD.right),
    height: Math.max(10, box.height - PAD.top - PAD.bottom),
  };

  const ticks = buildTicks(domainValues(spec));
  const span = ticks.max - ticks.min || 1;
  const toY = (value: number): number =>
    plot.y + plot.height - ((value - ticks.min) / span) * plot.height;

  const gridLines: GridLine[] = ticks.values.map((value) => ({
    y: toY(value),
    value,
    label: formatCompact(value),
    isZero: value === 0,
  }));

  const slotWidth = plot.width / Math.max(1, spec.categories.length);
  const categoryLabels: CategoryLabel[] = spec.categories.map((text, i) => ({
    x: plot.x + slotWidth * (i + 0.5),
    // The slot is all the room a category label has; a longer one is clipped
    // here rather than left to overlap its neighbour.
    text: truncateLabel(text, Math.max(3, Math.floor(slotWidth / (labelFontSize * CHAR_WIDTH_RATIO)))),
  }));

  const bars: BarMark[] = [];
  const lines: LineMark[] = [];

  if (spec.type === 'line') {
    for (let s = 0; s < spec.series.length; s++) {
      const points: PointMark[] = [];
      for (let c = 0; c < spec.categories.length; c++) {
        const value = spec.series[s].values[c];
        if (!Number.isFinite(value)) continue;
        points.push({
          seriesIndex: s,
          categoryIndex: c,
          x: plot.x + slotWidth * (c + 0.5),
          y: toY(value),
          value,
        });
      }
      lines.push({ seriesIndex: s, points });
    }
  } else if (spec.type === 'stacked_bar') {
    const barWidth = Math.min(slotWidth * 0.62, 46);
    for (let c = 0; c < spec.categories.length; c++) {
      let cursor = 0;
      for (let s = 0; s < spec.series.length; s++) {
        const value = spec.series[s].values[c] ?? 0;
        // Non-positive segments are dropped rather than stacked. A negative
        // value would walk the running total back down, so the next segment
        // would be drawn over the previous one and the column would no longer
        // sum to the total the axis was scaled against. A stack of mixed signs
        // is not a stacked bar; it needs a grouped one.
        if (!Number.isFinite(value) || value <= 0) continue;
        const yTop = toY(cursor + value);
        const yBottom = toY(cursor);
        cursor += value;
        // A hairline of surface between segments. Without it the stack reads
        // as one mass and the colour boundaries do the work alone — which is
        // exactly what a colour-vision-deficient reader cannot rely on.
        const rawHeight = Math.abs(yBottom - yTop);
        const height = Math.max(0.5, rawHeight - STACK_GAP);
        bars.push({
          seriesIndex: s,
          categoryIndex: c,
          x: plot.x + slotWidth * (c + 0.5) - barWidth / 2,
          y: Math.min(yTop, yBottom) + (rawHeight - height),
          width: barWidth,
          height,
          value,
          // A stacked segment is labelled by the legend, not in place: a
          // segment is often shorter than the text.
          label: null,
          labelX: 0,
          labelY: 0,
        });
      }
    }
  } else {
    // Not `Math.max(1, …)`: a zero-length series list would then index
    // `series[0]` and throw. The Zod schema forbids it on the tool path, but
    // this function is also reachable directly.
    const seriesCount = spec.series.length;
    const groupWidth = Math.min(slotWidth * 0.72, 54);
    const barWidth = groupWidth / seriesCount;
    const zeroY = toY(0);
    for (let c = 0; c < spec.categories.length; c++) {
      for (let s = 0; s < seriesCount; s++) {
        const value = spec.series[s].values[c];
        if (!Number.isFinite(value)) continue;
        const valueY = toY(value);
        const x = plot.x + slotWidth * (c + 0.5) - groupWidth / 2 + barWidth * s;
        const label = formatCompact(value);
        // Only label where the text fits inside the bar's own slot; otherwise
        // the axis and the legend carry the reading.
        const fits = textWidth(label, labelFontSize) <= barWidth + 2;
        bars.push({
          seriesIndex: s,
          categoryIndex: c,
          x,
          y: Math.min(valueY, zeroY),
          width: barWidth,
          height: Math.abs(zeroY - valueY),
          value,
          label: fits ? label : null,
          labelX: x + barWidth / 2,
          // Positive bars label above their top, negative below their bottom.
          labelY: value >= 0 ? valueY - 2.5 : valueY + labelFontSize + 1,
        });
      }
    }
  }

  return { plot, ticks, gridLines, categoryLabels, bars, lines, slices: [], legend };
}

/** Polar-to-cartesian on the pie's circle. Angles are clockwise from 12 o'clock. */
function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  const rad = (angle - 90) * (Math.PI / 180);
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function buildPieSlices(spec: ChartSpec, box: ChartBox): SliceMark[] {
  const values = spec.categories.map((_, i) => {
    const v = spec.series[0]?.values[i] ?? 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];

  const radius = Math.max(8, Math.min(box.width, box.height) / 2 - 6);
  const cx = box.width / 2;
  const cy = box.height / 2;

  const slices: SliceMark[] = [];
  let angle = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 0) continue;
    const sweep = (values[i] / total) * 360;
    // A slice at exactly 360° would collapse to a zero-length arc; draw two
    // half-arcs so a single-category pie still paints a full circle.
    const end = angle + Math.min(sweep, 359.999);
    const [x0, y0] = polar(cx, cy, radius, angle);
    const [x1, y1] = polar(cx, cy, radius, end);
    const largeArc = sweep > 180 ? 1 : 0;
    slices.push({
      categoryIndex: i,
      path: `M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`,
      value: values[i],
      percent: (values[i] / total) * 100,
      label: spec.categories[i],
    });
    angle = end;
  }
  return slices;
}
