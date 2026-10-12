/**
 * KPI cards — one ruled grid of metric cells, not a scatter of loose tiles.
 *
 * The cells share a single frame with hairline rules between them and a tinted
 * alternate row, so a six-metric block reads as one object the eye can scan in
 * two directions. Detached bordered tiles separated by gaps, which is what this
 * was, give every cell its own outline and leave the reader no row to follow.
 *
 * Text still wraps and the cell grows to fit it. The previous renderer drew
 * three fixed-width cards per row and truncated the value and hint to
 * `lines[0]`, so "Grab ~10x · Sea ~13x · Meituan ~19x" was silently delivered
 * as "Grab ~10x · Sea ~13x · Meituan".
 */
import { View, Text } from '@react-pdf/renderer';
import { COLOR, EYEBROW_TRACKING, FONT, LINE, typeStyle } from '../theme';
import type { ImageCache } from '../assets';
import type { KpiInput } from '../types';
import { Logo, Pill } from './primitives';

const PER_ROW = 3;
const RULE = 0.8;
const RADIUS = 4;

/** Split the cards into rows of at most `columns`. */
function chunk(cards: KpiInput[], columns: number): KpiInput[][] {
  const rows: KpiInput[][] = [];
  for (let i = 0; i < cards.length; i += columns) {
    rows.push(cards.slice(i, i + columns));
  }
  return rows;
}

export function KpiCards({ cards, images }: { cards: KpiInput[]; images: ImageCache }) {
  if (cards.length === 0) return null;

  // Fewer cards than a full row share the width rather than leaving two thirds
  // of the frame blank — a single KPI spans it, two take a half each.
  const columns = Math.min(PER_ROW, cards.length);
  const rows = chunk(cards, columns);
  const cellWidth = `${100 / columns}%`;

  return (
    // No outer bordered wrapper: when a block spans pages the wrapper's border
    // is painted down the unfilled tail of each page, leaving an empty ruled
    // stub under the last row — the same reason `Scorecard` rules its rows
    // individually. Here the first row carries the top rule and every row
    // carries the rest, which draws the identical frame and survives a break.
    <View style={{ marginBottom: 8 }}>
      {rows.map((row, r) => (
        <View
          key={`kpirow-${r}`}
          // A row moves whole: half a row of metrics at a page break reads as a
          // rendering fault, and a row is always short enough to move.
          wrap={false}
          style={{
            flexDirection: 'row',
            // Alternating tint, which is what gives the grid a horizontal
            // reading direction without drawing a heavier rule.
            backgroundColor: r % 2 === 1 ? COLOR.cardBg : COLOR.surface,
            borderLeftWidth: RULE,
            borderRightWidth: RULE,
            borderBottomWidth: RULE,
            borderTopWidth: r === 0 ? RULE : 0,
            borderColor: COLOR.border,
            borderTopLeftRadius: r === 0 ? RADIUS : 0,
            borderTopRightRadius: r === 0 ? RADIUS : 0,
            borderBottomLeftRadius: r === rows.length - 1 ? RADIUS : 0,
            borderBottomRightRadius: r === rows.length - 1 ? RADIUS : 0,
          }}
        >
          {row.map((card, c) => (
            <View
              key={`${card.label}-${c}`}
              style={{
                width: cellWidth,
                paddingVertical: 9,
                paddingHorizontal: 11,
                // Only between cells, so the rule never doubles up with the
                // frame's own left edge.
                borderLeftWidth: c === 0 ? 0 : RULE,
                borderLeftColor: COLOR.border,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
                <Logo url={card.logoUrl} images={images} size={9} />
                <Text
                  style={{
                    ...typeStyle(FONT.tiny, LINE.tight),
                    fontWeight: 700,
                    letterSpacing: EYEBROW_TRACKING,
                    textTransform: 'uppercase',
                    color: COLOR.textMuted,
                    flex: 1,
                  }}
                >
                  {card.label}
                </Text>
              </View>

              {/* A card carrying a tone is a status, not a quantity, so it is
                  set as a pill rather than as a headline number. */}
              {card.tone ? (
                <Pill pill={{ label: card.value, tone: card.tone }} />
              ) : (
                <Text
                  style={{
                    fontFamily: FONT.serif,
                    ...typeStyle(15, LINE.tight),
                    fontWeight: 600,
                    color: COLOR.brandNavy,
                  }}
                >
                  {card.value}
                </Text>
              )}

              {card.hint ? (
                <Text
                  style={{
                    ...typeStyle(FONT.tiny, LINE.tight),
                    color: COLOR.textMuted,
                    marginTop: 4,
                  }}
                >
                  {card.hint}
                </Text>
              ) : null}
            </View>
          ))}

          {/* Pad a short last row. The row's own fill and frame already reach
              the right margin — what these cells carry is the interior column
              rules, without which the grid loses its columns halfway down and
              the last row reads as a separate, wider box. */}
          {Array.from({ length: columns - row.length }, (_, c) => (
            <View
              key={`kpipad-${c}`}
              style={{
                width: cellWidth,
                borderLeftWidth: RULE,
                borderLeftColor: COLOR.border,
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
