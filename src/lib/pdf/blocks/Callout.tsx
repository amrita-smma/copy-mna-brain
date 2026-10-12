/**
 * A boxed aside — the one block in the vocabulary whose job is to *not* be
 * read as body copy.
 *
 * Two shapes, chosen by tone:
 *
 *   - `warning` / `info` / `positive` — a tinted box with a 3pt rule down its
 *     left edge and a small-caps label in the accent. This is the caveat form:
 *     "the figures above are internally recorded, not externally verified".
 *     `warning` is the amber one and the default.
 *   - `takeaway` — a filled navy panel with white text and orange bullets.
 *     Inverting it is what separates a summary from the section it summarises;
 *     a tinted box would read as one more aside among the others.
 *
 * Both accept a paragraph, a bullet list, or both. A callout carrying neither
 * renders nothing rather than an empty box.
 */
import { View, Text } from '@react-pdf/renderer';
import { COLOR, FONT, LINE, styles, typeStyle } from '../theme';
import type { CalloutTone } from '../types';

interface CalloutPalette {
  bg: string;
  /** The left rule, and the bullet dots. Null on `takeaway`, which is filled. */
  rule: string | null;
  /** The small-caps title. */
  label: string;
  body: string;
  /** The hairline between bullet items. */
  divider: string;
}

export function calloutPalette(tone: CalloutTone): CalloutPalette {
  switch (tone) {
    case 'takeaway':
      return {
        bg: COLOR.brandNavy,
        rule: null,
        label: COLOR.brandOrange,
        body: COLOR.white,
        divider: COLOR.brandNavyLine,
      };
    case 'info':
      return {
        bg: COLOR.calloutInfoBg,
        rule: COLOR.pillInfoFg,
        label: COLOR.pillInfoFg,
        body: COLOR.text,
        divider: COLOR.border,
      };
    case 'positive':
      return {
        bg: COLOR.calloutPositiveBg,
        rule: COLOR.pillPositiveFg,
        label: COLOR.pillPositiveFg,
        body: COLOR.text,
        divider: COLOR.border,
      };
    case 'warning':
    default:
      return {
        bg: COLOR.calloutWarnBg,
        rule: COLOR.brandOrange,
        label: COLOR.brandOrangeDeep,
        body: COLOR.text,
        divider: COLOR.border,
      };
  }
}

export function Callout({
  tone = 'warning',
  title,
  text,
  items = [],
}: {
  tone?: CalloutTone;
  title?: string;
  text?: string;
  items?: string[];
}) {
  if (!text && items.length === 0) return null;
  const palette = calloutPalette(tone);
  const bulletColor = palette.rule ?? COLOR.brandOrange;

  return (
    // Not `wrap={false}`: a long takeaway list is allowed to break across a
    // page, because forcing it whole would push a mostly-empty page ahead of
    // it. The tint and the left rule repeat on the continuation, which is what
    // keeps the aside legible as one thing.
    <View
      style={{
        backgroundColor: palette.bg,
        borderRadius: 3,
        borderLeftWidth: palette.rule ? 3 : 0,
        borderLeftColor: palette.rule ?? undefined,
        paddingVertical: 11,
        paddingHorizontal: 13,
        marginTop: 4,
        marginBottom: 10,
      }}
    >
      {title ? (
        <Text style={[styles.calloutEyebrow, { color: palette.label }]}>{title}</Text>
      ) : null}

      {text ? (
        <Text
          style={{
            ...typeStyle(FONT.body),
            color: palette.body,
            marginBottom: items.length > 0 ? 6 : 0,
          }}
        >
          {text}
        </Text>
      ) : null}

      {items.map((item, i) => (
        <View
          key={`${item}-${i}`}
          // One item moves whole. Without this the row splits at a page break
          // and leaves its dot behind on the previous page with nothing
          // beside it.
          wrap={false}
          style={{
            flexDirection: 'row',
            paddingTop: i === 0 ? 0 : 5,
            marginTop: i === 0 ? 0 : 5,
            borderTopWidth: i === 0 ? 0 : 0.5,
            borderTopColor: palette.divider,
          }}
        >
          {/* A filled dot rather than a bullet glyph: it is the one mark in the
              box that is pure accent, and it stays round at 7pt where "•"
              turns into a smudge. The top offset lines it up with the cap
              height of the first line, which a baseline-aligned glyph does for
              free and a <View> does not. */}
          <View
            style={{
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: bulletColor,
              marginTop: FONT.body * LINE.body * 0.5 - 2,
              marginRight: 8,
              flexShrink: 0,
            }}
          />
          <Text style={{ ...typeStyle(FONT.body), color: palette.body, flex: 1 }}>{item}</Text>
        </View>
      ))}
    </View>
  );
}
