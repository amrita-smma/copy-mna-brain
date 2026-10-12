/**
 * Renders the pure geometry from `geometry.ts` as PDF vector art.
 *
 * All arithmetic lives in `buildChartGeometry`; this file only translates
 * numbers into `<Svg>` primitives and picks colours, so there is nothing here
 * that can push a mark outside the plot box.
 *
 * Every chart is framed in a `figureCard` so a figure is bounded by something
 * other than white space, and `pie` specs are drawn as a donut with the total
 * in the hole — see `Donut` at the bottom of this file.
 */
import { View, Text, Svg, Line, Rect, Polyline, Circle, Path } from '@react-pdf/renderer';
import { COLOR, FONT, LINE, seriesColor, styles, typeStyle } from '../theme';
import { SERIF_FAMILY } from '../fonts';
import { formatCompact, formatPercent } from '../format';
import { buildChartGeometry, type ChartGeometry, type ChartSpec } from './geometry';

const TICK_FONT = 6.5;
/**
 * Size of a direct value label.
 *
 * This exact number is handed to `buildChartGeometry`, which decides which
 * labels fit, and it is the size they are actually drawn at below. The two
 * must not drift: measuring at 6.5 and inking at 7 lets geometry admit a label
 * that then collides with its neighbour, and the unit tests measure at 6.5 too,
 * so they would agree with the arithmetic and not with the page.
 */
const LABEL_FONT = 7;

export interface ChartProps {
  spec: ChartSpec;
  width: number;
  height: number;
  title?: string;
  /**
   * Shifts every series onto a later categorical slot. Used only by the legacy
   * `bar_chart` block, whose `accent: 'secondary'` selected a second colour.
   */
  colorOffset?: number;
}

/**
 * The legend is not optional decoration.
 *
 * A categorical slot sitting below 3:1 contrast on white is only legible as an
 * identity channel when a text label travels with the swatch. A single-series
 * chart needs none — the title names it.
 */
function Legend({ names, offset = 0 }: { names: string[]; offset?: number }) {
  if (names.length < 2) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginTop: 6,
        gap: 12,
      }}
    >
      {names.map((name, i) => (
        <View key={`${name}-${i}`} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 1,
              backgroundColor: seriesColor(i + offset),
              marginRight: 5,
            }}
          />
          <Text style={{ fontSize: FONT.tiny, color: COLOR.textMuted }}>{name}</Text>
        </View>
      ))}
    </View>
  );
}

export function Chart({ spec, width, height, title, colorOffset = 0 }: ChartProps) {
  const g = buildChartGeometry(spec, { width, height }, LABEL_FONT);
  const color = (index: number): string => seriesColor(index + colorOffset);

  return (
    // `wrap={false}` keeps a chart whole: half a chart at a page break reads as
    // a rendering fault, and charts are always short enough to move entire.
    <View style={styles.figureCard} wrap={false}>
      {title ? (
        <Text style={styles.figureTitle}>
          {spec.unit ? `${title} (${spec.unit})` : title}
        </Text>
      ) : null}

      {spec.type === 'pie' ? (
        <Donut g={g} size={width} unit={spec.unit} color={color} />
      ) : (
        <>
          <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
            {/* Gridlines, recessive — the zero line reads one step stronger. */}
            {g.gridLines.map((line) => (
              <Line
                key={`grid-${line.value}`}
                x1={g.plot.x}
                y1={line.y}
                x2={g.plot.x + g.plot.width}
                y2={line.y}
                strokeWidth={line.isZero ? 0.7 : 0.4}
                stroke={line.isZero ? COLOR.borderStrong : COLOR.border}
              />
            ))}

            {/* Y tick labels, right-aligned into the left gutter. */}
            {g.gridLines.map((line) => (
              <Text
                key={`tick-${line.value}`}
                x={g.plot.x - 6}
                y={line.y + TICK_FONT * 0.35}
                style={{ fontSize: TICK_FONT, fill: COLOR.textMuted, textAnchor: 'end' }}
              >
                {line.label}
              </Text>
            ))}

            {/* Bars (grouped and stacked alike). The 0.75pt inset on each side is
                the 2px-at-screen-scale surface gap that keeps adjacent fills from
                reading as one mass. */}
            {g.bars.map((bar, i) => (
              <Rect
                key={`bar-${i}`}
                x={bar.x + 0.75}
                y={bar.y}
                width={Math.max(0.5, bar.width - 1.5)}
                height={Math.max(0.5, bar.height)}
                fill={color(bar.seriesIndex)}
              />
            ))}

            {/* Direct value labels — only those geometry decided actually fit.
                Set bold in the body ink rather than muted: the number a bar
                encodes is the thing being read, so it should not be quieter
                than the axis it is measured against. */}
            {g.bars.map((bar, i) =>
              bar.label ? (
                <Text
                  key={`barlabel-${i}`}
                  x={bar.labelX}
                  y={bar.labelY}
                  style={{
                    fontSize: LABEL_FONT,
                    fontWeight: 700,
                    fill: COLOR.brandNavy,
                    textAnchor: 'middle',
                  }}
                >
                  {bar.label}
                </Text>
              ) : null,
            )}

            {/* Lines, with a marker at each point so a single-point series is visible. */}
            {g.lines.map((line) => (
              <Polyline
                key={`line-${line.seriesIndex}`}
                points={line.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={color(line.seriesIndex)}
                strokeWidth={1.4}
              />
            ))}
            {g.lines.flatMap((line) =>
              line.points.map((p) => (
                <Circle
                  key={`pt-${line.seriesIndex}-${p.categoryIndex}`}
                  cx={p.x}
                  cy={p.y}
                  r={2}
                  fill={color(line.seriesIndex)}
                  stroke={COLOR.surface}
                  strokeWidth={0.8}
                />
              )),
            )}

            {/* Category labels along the x axis. */}
            {g.categoryLabels.map((label, i) => (
              <Text
                key={`cat-${i}`}
                x={label.x}
                y={g.plot.y + g.plot.height + TICK_FONT + 5}
                style={{ fontSize: TICK_FONT, fill: COLOR.textMuted, textAnchor: 'middle' }}
              >
                {label.text}
              </Text>
            ))}
          </Svg>

          <Legend names={g.legend} offset={colorOffset} />
        </>
      )}
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Donut
// ───────────────────────────────────────────────────────────────────────────

/** Width of the ring, which sets the width of the legend's bar column too. */
const LEGEND_BAR_WIDTH = 70;

/**
 * A share-of-whole figure: the ring on the left, the numbers on the right.
 *
 * The legend is a table rather than a list of swatches because the three
 * things a reader wants from this chart — how big each slice is, what share
 * that is, and how they rank — are all hard to take off a ring. The bar in the
 * last column is the ring's own geometry unrolled, so the comparison that the
 * angles only imply can be made by eye along a common baseline.
 */
function Donut({
  g,
  size,
  unit,
  color,
}: {
  g: ChartGeometry;
  size: number;
  unit?: string;
  color: (index: number) => string;
}) {
  if (!g.donut || g.slices.length === 0) {
    return <Text style={[styles.paragraph, styles.muted]}>(no positive values to chart)</Text>;
  }
  const { cx, cy, innerRadius, total } = g.donut;
  const maxPercent = Math.max(...g.slices.map((s) => s.percent));

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {g.slices.map((slice) => (
          <Path
            key={`slice-${slice.categoryIndex}`}
            d={slice.path}
            fill={color(slice.categoryIndex)}
            stroke={COLOR.surface}
            strokeWidth={1.2}
          />
        ))}

        {/* The total, in the hole. Sized against the hole rather than fixed, so
            a smaller ring does not print its total over its own segments.
            `formatCompact` emits digits, a dot, a minus and a k/M/B/T suffix,
            all of which the serif covers, so this one string can name the
            family directly instead of going through `SERIF_STACK` — SVG text
            is drawn outside the layout engine's glyph-substitution pass. */}
        <Text
          x={cx}
          y={cy + innerRadius * 0.08}
          style={{
            fontFamily: SERIF_FAMILY,
            fontSize: Math.min(16, innerRadius * 0.52),
            fontWeight: 700,
            fill: COLOR.brandNavy,
            textAnchor: 'middle',
          }}
        >
          {formatCompact(total)}
        </Text>
        <Text
          x={cx}
          y={cy + innerRadius * 0.08 + 10}
          style={{ fontSize: FONT.tiny - 0.5, fill: COLOR.textMuted, textAnchor: 'middle' }}
        >
          {unit ? `Total · ${unit}` : 'Total'}
        </Text>
      </Svg>

      <View style={{ flex: 1, marginLeft: 16 }}>
        {g.slices.map((slice, row) => (
          <View
            key={`legendrow-${slice.categoryIndex}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 4,
              // A rule between rows, not around them: the table is read across,
              // and a full border would compete with the figure card's own.
              borderTopWidth: row === 0 ? 0 : 0.5,
              borderTopColor: COLOR.border,
            }}
          >
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 1,
                backgroundColor: color(slice.categoryIndex),
                marginRight: 7,
                flexShrink: 0,
              }}
            />
            <Text style={{ ...typeStyle(FONT.small, LINE.tight), flex: 1, paddingRight: 6 }}>
              {slice.label}
            </Text>
            <Text
              style={{
                ...typeStyle(FONT.small, LINE.tight),
                fontWeight: 700,
                color: COLOR.brandNavy,
                width: 38,
                textAlign: 'right',
              }}
            >
              {formatCompact(slice.value)}
            </Text>
            <Text
              style={{
                ...typeStyle(FONT.small, LINE.tight),
                color: COLOR.textMuted,
                width: 36,
                textAlign: 'right',
                marginRight: 10,
              }}
            >
              {formatPercent(slice.percent)}
            </Text>
            {/* Scaled to the largest slice, not to 100%, so the smallest share
                in a flat breakdown is still a visible bar rather than a dot. */}
            <View
              style={{
                width: LEGEND_BAR_WIDTH,
                height: 3,
                flexShrink: 0,
                backgroundColor: COLOR.border,
                borderRadius: 1.5,
              }}
            >
              <View
                style={{
                  width: `${Math.max(3, (slice.percent / maxPercent) * 100)}%`,
                  height: 3,
                  backgroundColor: color(slice.categoryIndex),
                  borderRadius: 1.5,
                }}
              />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
