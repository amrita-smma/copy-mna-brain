import { describe, it, expect } from 'vitest';
import {
  buildChartGeometry,
  boldTextWidth,
  textWidth,
  STACK_GAP,
  type ChartSpec,
} from './geometry';

const BOX = { width: 500, height: 170 };

const barSpec = (categories: string[], values: number[]): ChartSpec => ({
  type: 'bar',
  categories,
  series: [{ name: 'Revenue', values }],
});

describe('buildChartGeometry — plot frame', () => {
  it('keeps every mark inside the chart box', () => {
    const g = buildChartGeometry(barSpec(['FY24', 'FY25', 'FY26'], [15894, 18322, 20757]), BOX);
    expect(g.plot.x).toBeGreaterThan(0);
    expect(g.plot.x + g.plot.width).toBeLessThanOrEqual(BOX.width);
    expect(g.plot.y + g.plot.height).toBeLessThanOrEqual(BOX.height);
    for (const bar of g.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(g.plot.x - 0.01);
      expect(bar.x + bar.width).toBeLessThanOrEqual(g.plot.x + g.plot.width + 0.01);
      expect(bar.y).toBeGreaterThanOrEqual(g.plot.y - 0.01);
      expect(bar.y + bar.height).toBeLessThanOrEqual(g.plot.y + g.plot.height + 0.01);
    }
  });

  it('does not collapse the plot when handed a tiny box', () => {
    const g = buildChartGeometry(barSpec(['a'], [1]), { width: 20, height: 20 });
    expect(g.plot.width).toBeGreaterThan(0);
    expect(g.plot.height).toBeGreaterThan(0);
  });
});

describe('buildChartGeometry — bars', () => {
  it('anchors bars to the zero line and scales height by value', () => {
    const g = buildChartGeometry(barSpec(['a', 'b'], [100, 200]), BOX);
    const [a, b] = g.bars;
    expect(b.height).toBeCloseTo(a.height * 2, 1);
    const zero = g.gridLines.find((l) => l.isZero)!;
    expect(a.y + a.height).toBeCloseTo(zero.y, 1);
  });

  it('draws a negative bar downward from the zero line', () => {
    const g = buildChartGeometry(barSpec(['loss', 'profit'], [-10279, 575]), BOX);
    const zero = g.gridLines.find((l) => l.isZero)!;
    const loss = g.bars[0];
    expect(loss.y).toBeCloseTo(zero.y, 1);
    expect(loss.height).toBeGreaterThan(0);
    expect(loss.labelY).toBeGreaterThan(zero.y);
  });

  it('suppresses a direct label that would reach its neighbour — the old collision', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `M${i + 1}`);
    const g = buildChartGeometry(
      barSpec(twelve, twelve.map((_, i) => -10279 + i * 137)),
      BOX,
    );
    // One series, so each label sits alone in its category slot and that slot
    // is the whole budget it has.
    const slot = g.plot.width / 12;
    for (const bar of g.bars) {
      if (bar.label === null) continue;
      expect(boldTextWidth(bar.label, 6.5)).toBeLessThanOrEqual(slot + 2);
    }
  });

  it('measures a grouped chart label against its own bar, not the slot', () => {
    const categories = ['a', 'b', 'c', 'd', 'e', 'f'];
    const g = buildChartGeometry(
      {
        type: 'bar',
        categories,
        // Four series per slot, each value long enough that only the bar
        // width can decide: anything that fits the slot would collide.
        series: Array.from({ length: 4 }, (_, s) => ({
          name: `s${s}`,
          values: categories.map(() => -102790 - s),
        })),
      },
      BOX,
    );
    expect(g.bars.some((b) => b.label === null)).toBe(true);
    for (const bar of g.bars) {
      if (bar.label === null) continue;
      expect(boldTextWidth(bar.label, 6.5)).toBeLessThanOrEqual(bar.width + 2);
    }
  });

  it('keeps labels when there is room for them', () => {
    const g = buildChartGeometry(barSpec(['FY24', 'FY25'], [15, 18]), BOX);
    expect(g.bars.every((b) => b.label !== null)).toBe(true);
  });

  it('labels a lone series even where the text overhangs its own bar', () => {
    // Sixteen bars in a 460pt plot: each bar is 20.7pt wide inside a 28.8pt
    // slot, and "-10.3k" is 23.4pt — wider than the bar it sits on, narrower
    // than the gap to the next label. Budgeting against the bar instead
    // dropped labels off charts that plainly had room for them.
    const categories = Array.from({ length: 16 }, (_, i) => `M${i + 1}`);
    const g = buildChartGeometry(
      barSpec(categories, categories.map(() => -10_279)),
      BOX,
    );
    expect(g.bars.every((b) => b.label !== null)).toBe(true);
    expect(g.bars.every((b) => boldTextWidth(b.label!, 6.5) > b.width)).toBe(true);
  });

  it('never lets two labelled bars in the same row overlap horizontally', () => {
    const g = buildChartGeometry(
      barSpec(['a', 'b', 'c', 'd', 'e', 'f'], [12, 34, 56, 78, 90, 21]),
      BOX,
    );
    const labelled = g.bars.filter((b) => b.label !== null).sort((x, y) => x.labelX - y.labelX);
    for (let i = 1; i < labelled.length; i++) {
      const prevRight = labelled[i - 1].labelX + textWidth(labelled[i - 1].label!, 6.5) / 2;
      const nextLeft = labelled[i].labelX - textWidth(labelled[i].label!, 6.5) / 2;
      expect(nextLeft).toBeGreaterThanOrEqual(prevRight);
    }
  });

  it('splits a grouped bar slot evenly between series', () => {
    const g = buildChartGeometry(
      {
        type: 'bar',
        categories: ['FY25', 'FY26'],
        series: [
          { name: 'Revenue', values: [10, 12] },
          { name: 'EBITDA', values: [3, 4] },
        ],
      },
      BOX,
    );
    expect(g.bars).toHaveLength(4);
    const first = g.bars.filter((b) => b.categoryIndex === 0).sort((a, b) => a.x - b.x);
    expect(first[0].width).toBeCloseTo(first[1].width, 6);
    expect(first[1].x).toBeCloseTo(first[0].x + first[0].width, 6);
  });

  it('skips a non-finite value instead of drawing a NaN-sized bar', () => {
    const g = buildChartGeometry(barSpec(['a', 'b', 'c'], [10, Number.NaN, 30]), BOX);
    expect(g.bars).toHaveLength(2);
    expect(g.bars.every((b) => Number.isFinite(b.height))).toBe(true);
  });
});

describe('buildChartGeometry — stacked bars', () => {
  it('stacks segments contiguously and scales the axis to the column total', () => {
    const spec: ChartSpec = {
      type: 'stacked_bar',
      categories: ['FY25', 'FY26'],
      series: [
        { name: 'On-demand', values: [40, 50] },
        { name: 'Fintech', values: [60, 70] },
      ],
    };
    const g = buildChartGeometry(spec, BOX);
    expect(g.ticks.max).toBeGreaterThanOrEqual(120);
    const col = g.bars.filter((b) => b.categoryIndex === 1).sort((a, b) => b.y - a.y);
    // Segments are contiguous apart from the deliberate surface gap between them.
    expect(col[0].y - (col[1].y + col[1].height)).toBeCloseTo(STACK_GAP, 6);
  });

  it('separates every adjacent pair by the surface gap, never overlapping', () => {
    const g = buildChartGeometry(
      {
        type: 'stacked_bar',
        categories: ['FY25'],
        series: [
          { name: 'a', values: [30] },
          { name: 'b', values: [40] },
          { name: 'c', values: [50] },
        ],
      },
      BOX,
    );
    const col = [...g.bars].sort((a, b) => b.y - a.y);
    for (let i = 1; i < col.length; i++) {
      expect(col[i - 1].y).toBeGreaterThanOrEqual(col[i].y + col[i].height);
    }
  });

  it('drops a negative segment instead of walking the stack back down', () => {
    const g = buildChartGeometry(
      {
        type: 'stacked_bar',
        categories: ['FY25'],
        series: [
          { name: 'up', values: [40] },
          { name: 'down', values: [-15] },
          { name: 'up again', values: [20] },
        ],
      },
      BOX,
    );
    expect(g.bars.map((b) => b.seriesIndex)).toEqual([0, 2]);
    // The axis is scaled to the positive total only, so the column still fits.
    expect(g.ticks.max).toBeGreaterThanOrEqual(60);
    const col = [...g.bars].sort((a, b) => b.y - a.y);
    expect(col[0].y).toBeGreaterThanOrEqual(col[1].y + col[1].height);
  });

  it('labels stacked segments through the legend, not in place', () => {
    const g = buildChartGeometry(
      {
        type: 'stacked_bar',
        categories: ['a'],
        series: [
          { name: 'x', values: [1] },
          { name: 'y', values: [2] },
        ],
      },
      BOX,
    );
    expect(g.bars.every((b) => b.label === null)).toBe(true);
    expect(g.legend).toEqual(['x', 'y']);
  });
});

describe('buildChartGeometry — degenerate input', () => {
  it('returns no marks for an empty series list rather than throwing', () => {
    for (const type of ['bar', 'stacked_bar', 'line', 'pie'] as const) {
      const g = buildChartGeometry({ type, categories: ['a', 'b'], series: [] }, BOX);
      expect(g.bars).toEqual([]);
      expect(g.lines).toEqual([]);
      expect(g.slices).toEqual([]);
    }
  });

  it('returns no marks for an empty category list', () => {
    const g = buildChartGeometry(
      { type: 'bar', categories: [], series: [{ name: 'a', values: [] }] },
      BOX,
    );
    expect(g.bars).toEqual([]);
    expect(g.categoryLabels).toEqual([]);
  });
});

describe('buildChartGeometry — lines', () => {
  it('places one point per finite category, centred in its slot', () => {
    const g = buildChartGeometry(
      {
        type: 'line',
        categories: ['Q1', 'Q2', 'Q3'],
        series: [{ name: 'Margin', values: [1, 2, 3] }],
      },
      BOX,
    );
    expect(g.lines).toHaveLength(1);
    expect(g.lines[0].points).toHaveLength(3);
    const xs = g.lines[0].points.map((p) => p.x);
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 6);
    expect(g.lines[0].points[2].y).toBeLessThan(g.lines[0].points[0].y);
  });

  it('drops a gap rather than plotting a non-finite point', () => {
    const g = buildChartGeometry(
      {
        type: 'line',
        categories: ['Q1', 'Q2', 'Q3'],
        series: [{ name: 'Margin', values: [1, Number.NaN, 3] }],
      },
      BOX,
    );
    expect(g.lines[0].points.map((p) => p.categoryIndex)).toEqual([0, 2]);
  });
});

describe('buildChartGeometry — donut', () => {
  it('returns a ring whose hole is inside it, and the total that goes in the hole', () => {
    const g = buildChartGeometry(
      {
        type: 'pie',
        categories: ['Cash', 'Tokopedia', 'Jago'],
        series: [{ name: 'Mix', values: [50, 30, 20] }],
      },
      { width: 160, height: 160 },
    );
    expect(g.donut).not.toBeNull();
    const donut = g.donut!;
    expect(donut.total).toBe(100);
    expect(donut.innerRadius).toBeGreaterThan(0);
    expect(donut.innerRadius).toBeLessThan(donut.outerRadius);
    expect(donut.outerRadius).toBeLessThanOrEqual(80);
    expect(donut.cx).toBeCloseTo(80, 6);
    expect(donut.cy).toBeCloseTo(80, 6);
  });

  it('sums only the positive values into the centre total', () => {
    const g = buildChartGeometry(
      {
        type: 'pie',
        categories: ['a', 'b', 'c'],
        series: [{ name: 'Mix', values: [10, 0, -5] }],
      },
      { width: 120, height: 120 },
    );
    // Not 5: the negative is dropped, not subtracted, so the ring and the
    // number in its hole are built from the same values.
    expect(g.donut?.total).toBe(10);
  });

  it('draws each segment as a ring, with an arc out and an arc back', () => {
    const g = buildChartGeometry(
      {
        type: 'pie',
        categories: ['a', 'b'],
        series: [{ name: 'Mix', values: [70, 30] }],
      },
      { width: 160, height: 160 },
    );
    for (const slice of g.slices) {
      // Two arcs — the outer edge and the hole — not a wedge's single one.
      expect(slice.path.match(/A /g)).toHaveLength(2);
      expect(slice.path).not.toMatch(/NaN/);
    }
  });

  it('leaves the donut frame null when nothing is positive', () => {
    const g = buildChartGeometry(
      { type: 'pie', categories: ['a'], series: [{ name: 'Mix', values: [0] }] },
      { width: 120, height: 120 },
    );
    expect(g.donut).toBeNull();
    expect(g.slices).toEqual([]);
  });

  it('leaves the donut frame null for every chart that is not a pie', () => {
    for (const type of ['bar', 'stacked_bar', 'line'] as const) {
      const g = buildChartGeometry(
        { type, categories: ['a'], series: [{ name: 'x', values: [1] }] },
        BOX,
      );
      expect(g.donut).toBeNull();
    }
  });

  it('produces one wedge per positive category, summing to 100 percent', () => {
    const g = buildChartGeometry(
      {
        type: 'pie',
        categories: ['Cash', 'Tokopedia', 'Jago'],
        series: [{ name: 'Mix', values: [50, 30, 20] }],
      },
      { width: 160, height: 160 },
    );
    expect(g.slices).toHaveLength(3);
    expect(g.slices.reduce((s, x) => s + x.percent, 0)).toBeCloseTo(100, 6);
    expect(g.slices[0].percent).toBeCloseTo(50, 6);
    expect(g.slices.every((s) => s.path.startsWith('M ') && s.path.endsWith('Z'))).toBe(true);
    expect(g.legend).toEqual(['Cash', 'Tokopedia', 'Jago']);
  });

  it('ignores zero and negative values', () => {
    const g = buildChartGeometry(
      {
        type: 'pie',
        categories: ['a', 'b', 'c'],
        series: [{ name: 'Mix', values: [10, 0, -5] }],
      },
      { width: 120, height: 120 },
    );
    expect(g.slices).toHaveLength(1);
    expect(g.slices[0].percent).toBe(100);
  });

  it('returns no slices when nothing is positive, instead of a divide by zero', () => {
    const g = buildChartGeometry(
      { type: 'pie', categories: ['a'], series: [{ name: 'Mix', values: [0] }] },
      { width: 120, height: 120 },
    );
    expect(g.slices).toEqual([]);
  });

  it('draws a single full-circle slice as an arc that does not collapse', () => {
    const g = buildChartGeometry(
      { type: 'pie', categories: ['only'], series: [{ name: 'Mix', values: [7] }] },
      { width: 120, height: 120 },
    );
    expect(g.slices).toHaveLength(1);
    expect(g.slices[0].path).toContain('A');
    expect(g.slices[0].path).not.toMatch(/NaN/);
  });
});

describe('buildChartGeometry — axis labels', () => {
  it('truncates a category label to its slot width', () => {
    const g = buildChartGeometry(
      barSpec(
        ['Financial year two thousand twenty four', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        [1, 2, 3, 4, 5, 6, 7, 8],
      ),
      BOX,
    );
    const slot = g.plot.width / 8;
    for (const label of g.categoryLabels) {
      expect(textWidth(label.text, 6.5)).toBeLessThanOrEqual(slot + 0.01);
    }
    expect(g.categoryLabels[0].text).toContain('…');
  });

  it('writes gridline labels in compact form, never a raw float', () => {
    const g = buildChartGeometry(barSpec(['a', 'b'], [15894, 20757]), BOX);
    expect(g.gridLines.every((l) => !/\d{6,}/.test(l.label))).toBe(true);
    expect(g.gridLines.some((l) => l.isZero)).toBe(true);
  });

  it('orders gridlines top to bottom with the largest value first', () => {
    const g = buildChartGeometry(barSpec(['a'], [100]), BOX);
    const sorted = [...g.gridLines].sort((a, b) => a.y - b.y);
    expect(sorted[0].value).toBeGreaterThan(sorted[sorted.length - 1].value);
  });
});
