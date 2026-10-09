/**
 * A 2×2 matrix.
 *
 * Cells have a `minHeight` rather than a fixed height, so a dense quadrant
 * grows instead of clipping its items mid-list, and the axis labels sit inside
 * the content box instead of 2pt past the right margin.
 */
import { View, Text } from '@react-pdf/renderer';
import { COLOR, FONT, LINE, typeStyle } from '../theme';
import type { QuadrantsInput } from '../types';

const CELL_MIN_HEIGHT = 86;

function Cell({ items, background }: { items: string[]; background: string }) {
  const empty = items.length === 0;
  return (
    <View
      style={{
        flex: 1,
        minHeight: CELL_MIN_HEIGHT,
        backgroundColor: background,
        borderWidth: 0.6,
        borderColor: COLOR.border,
        borderRadius: 3,
        padding: 7,
      }}
    >
      {(empty ? ['(none)'] : items).map((item, i) => (
        <View key={`${item}-${i}`} style={{ flexDirection: 'row', marginBottom: 2 }}>
          <Text style={{ width: 7, color: COLOR.textMuted, ...typeStyle(FONT.small, LINE.tight) }}>•</Text>
          <Text
            style={{
              flex: 1,
              ...typeStyle(FONT.small, LINE.tight),
              color: empty ? COLOR.textMuted : COLOR.text,
            }}
          >
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

function AxisLabel({ text, align }: { text?: string; align: 'left' | 'right' }) {
  return (
    <Text
      style={{
        flex: 1,
        fontSize: FONT.tiny,
        fontWeight: 600,
        color: COLOR.textMuted,
        textAlign: 'center',
        paddingHorizontal: align === 'left' ? 0 : 0,
      }}
    >
      {text ? text.toUpperCase() : ' '}
    </Text>
  );
}

/**
 * The y-axis labels are rendered as a left gutter column rather than beside the
 * page edge, so the grid is 2pt narrower but nothing is drawn outside the
 * margin.
 */
function RowLabel({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Text
      style={{
        width: 46,
        ...typeStyle(FONT.tiny, LINE.tight),
        fontWeight: 600,
        color: COLOR.textMuted,
        paddingRight: 5,
        alignSelf: 'center',
      }}
    >
      {text.toUpperCase()}
    </Text>
  );
}

export function Quadrants({ quadrants: q }: { quadrants: QuadrantsInput }) {
  const hasRowLabels = Boolean(q.yLabelHigh || q.yLabelLow);
  const gutter = hasRowLabels ? 46 : 0;

  return (
    <View style={{ marginBottom: 8 }} wrap={false}>
      {q.xLabelLow || q.xLabelHigh ? (
        <View style={{ flexDirection: 'row', marginLeft: gutter, marginBottom: 3, gap: 6 }}>
          <AxisLabel text={q.xLabelLow} align="left" />
          <AxisLabel text={q.xLabelHigh} align="right" />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
        {hasRowLabels ? <RowLabel text={q.yLabelHigh ?? ' '} /> : null}
        <Cell items={q.topLeft} background={COLOR.quadrantTopBg} />
        <Cell items={q.topRight} background={COLOR.quadrantTopBg} />
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {hasRowLabels ? <RowLabel text={q.yLabelLow ?? ' '} /> : null}
        <Cell items={q.bottomLeft} background={COLOR.quadrantBottomBg} />
        <Cell items={q.bottomRight} background={COLOR.quadrantBottomBg} />
      </View>
    </View>
  );
}
