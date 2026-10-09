/**
 * The scorecard table — the block the overlap report was actually about.
 *
 * Three things make it correct where the previous version was not:
 *
 *  1. Columns are flex ratios, not absolute x offsets. The verdict column grows
 *     to fit its pill instead of letting a long label print on top of the notes
 *     column.
 *  2. The header row is `fixed`, so it repeats at the top of every page the
 *     table spans rather than orphaning at the bottom of one.
 *  3. Each data row is `wrap={false}`, so a row moves to the next page whole.
 *     A row taller than a page is the one case that still has to split, which
 *     `wrap={false}` permits rather than clipping.
 */
import { View, Text } from '@react-pdf/renderer';
import { COLOR, FONT, LINE, typeStyle } from '../theme';
import type { ImageCache } from '../assets';
import type { PillInput, ScorecardRowInput } from '../types';
import { Logo, Pill } from './primitives';

export interface ScorecardProps {
  rows: ScorecardRowInput[];
  overallPill?: PillInput;
  overallNote?: string;
  columns?: { label?: string; verdict?: string; rationale?: string };
  images: ImageCache;
  repeatHeader?: boolean;
}

/** Table cells run one notch tighter than prose so rows stay compact. */
const CELL_TEXT = typeStyle(FONT.body, LINE.tight);

const COL = {
  label: { width: '27%' },
  verdict: { width: '18%' },
  rationale: { flex: 1 },
} as const;

export function Scorecard({ rows, overallPill, overallNote, columns, images, repeatHeader = true }: ScorecardProps) {
  if (rows.length === 0) return null;

  const headers = {
    label: columns?.label ?? 'Item',
    verdict: columns?.verdict ?? 'Verdict',
    rationale: columns?.rationale ?? 'Notes',
  };

  const headerCell = {
    ...typeStyle(FONT.tiny, LINE.tight),
    fontWeight: 600,
    color: COLOR.textMuted,
  } as const;

  return (
    <View style={{ marginBottom: 8 }}>
      {/* No outer bordered box around the rows: when the table spans pages the
          wrapper's border is painted down the unfilled tail of each page,
          leaving an empty ruled stub under the last row. Each row carries its
          own rules instead. */}
      <View>
        <View
          fixed={repeatHeader}
          style={{
            flexDirection: 'row',
            backgroundColor: COLOR.cardBg,
            paddingVertical: 4,
            paddingHorizontal: 6,
            borderWidth: 0.5,
            borderColor: COLOR.border,
          }}
        >
          <Text style={{ ...COL.label, ...headerCell, paddingRight: 6 }}>{headers.label}</Text>
          <Text style={{ ...COL.verdict, ...headerCell, paddingRight: 6 }}>{headers.verdict}</Text>
          <Text style={{ ...COL.rationale, ...headerCell }}>{headers.rationale}</Text>
        </View>

        {rows.map((row, i) => (
          <View
            key={`${row.label}-${i}`}
            wrap={false}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              paddingVertical: 5,
              paddingHorizontal: 6,
              borderLeftWidth: 0.5,
              borderRightWidth: 0.5,
              borderBottomWidth: 0.5,
              borderColor: COLOR.border,
            }}
          >
            <View style={{ ...COL.label, flexDirection: 'row', paddingRight: 6 }}>
              <Logo url={row.logoUrl} images={images} size={10} />
              <Text style={{ fontWeight: 600, flex: 1, ...CELL_TEXT }}>{row.label}</Text>
            </View>
            <View style={{ ...COL.verdict, paddingRight: 6 }}>
              <Pill pill={row.pill} />
            </View>
            <Text style={{ ...COL.rationale, ...CELL_TEXT }}>{row.rationale}</Text>
          </View>
        ))}
      </View>

      {overallPill ? (
        <View
          wrap={false}
          // `flex-start`, not `center`: a wrapping note would otherwise drag
          // the label and pill down to the vertical middle of the row.
          style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: 6, gap: 6 }}
        >
          <Text style={{ fontWeight: 700, flexShrink: 0, ...CELL_TEXT }}>Overall:</Text>
          <Pill pill={overallPill} />
          {overallNote ? (
            // `flex: 1` is what makes a long note wrap instead of running off
            // the page as it did when it was drawn at an absolute x.
            <Text style={{ flex: 1, color: COLOR.textMuted, ...CELL_TEXT }}>
              {overallNote}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
