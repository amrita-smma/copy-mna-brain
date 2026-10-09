/**
 * Renders the pure geometry from `geometry.ts` as PDF vector art.
 *
 * All arithmetic lives in `buildChartGeometry`; this file only translates
 * numbers into `<Svg>` primitives and picks colours, so there is nothing here
 * that can push a mark outside the plot box.
 */
import { View, Text, Svg, Line, Rect, Polyline, Circle, Path } from '@react-pdf/renderer';
import { COLOR, FONT, seriesColor } from '../theme';
import { formatCompact, formatPercent } from '../format';
import { buildChartGeometry, type ChartSpec } from './geometry';

const TICK_FONT = 6.5;
const LABEL_FONT = 6.5;

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
 * Three of the eight categorical slots sit below 3:1 contrast on white, so the
 * palette is only legible as an identity channel when a text label travels
 * with the swatch. A single-series chart needs none — the title names it.
 */
function Legend({ names, offset = 0 }: { names: string[]; offset?: number }) {
  if (names.length < 2) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginTop: 4,
        gap: 10,
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
              marginRight: 4,
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
  const isPie = spec.type === 'pie';
  const color = (index: number): string => seriesColor(index + colorOffset);

  return (
    // `wrap={false}` keeps a chart whole: half a chart at a page break reads as
    // a rendering fault, and charts are always short enough to move entire.
    <View style={{ marginBottom: 10 }} wrap={false}>
      {title ? (
        <Text style={{ fontSize: FONT.subsection, fontWeight: 600, marginBottom: 3 }}>
          {spec.unit ? `${title} (${spec.unit})` : title}
        </Text>
      ) : null}

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
            x={g.plot.x - 4}
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

        {/* Direct value labels — only those geometry decided actually fit. */}
        {g.bars.map((bar, i) =>
          bar.label ? (
            <Text
              key={`barlabel-${i}`}
              x={bar.labelX}
              y={bar.labelY}
              style={{ fontSize: LABEL_FONT, fill: COLOR.textMuted, textAnchor: 'middle' }}
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
            y={g.plot.y + g.plot.height + TICK_FONT + 4}
            style={{ fontSize: TICK_FONT, fill: COLOR.textMuted, textAnchor: 'middle' }}
          >
            {label.text}
          </Text>
        ))}

        {/* Pie wedges, separated by a surface-coloured hairline. */}
        {g.slices.map((slice) => (
          <Path
            key={`slice-${slice.categoryIndex}`}
            d={slice.path}
            fill={color(slice.categoryIndex)}
            stroke={COLOR.surface}
            strokeWidth={1}
          />
        ))}
      </Svg>

      {isPie ? (
        // Capped: a pie's legend reads as part of the figure, so letting its
        // rows span the full content width detaches the values from the wedges.
        <View style={{ marginTop: 4, maxWidth: 300 }}>
          {g.slices.map((slice) => (
            <View
              key={`pielegend-${slice.categoryIndex}`}
              style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 1,
                  backgroundColor: color(slice.categoryIndex),
                  marginRight: 4,
                }}
              />
              <Text style={{ fontSize: FONT.tiny, color: COLOR.textMuted, flex: 1 }}>
                {slice.label}
              </Text>
              <Text style={{ fontSize: FONT.tiny, color: COLOR.textMuted }}>
                {`${formatCompact(slice.value)} · ${formatPercent(slice.percent)}`}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Legend names={g.legend} offset={colorOffset} />
      )}
    </View>
  );
}
