/**
 * Visual tokens for the research-summary PDF.
 *
 * The palette is a direct port of the `COLORS` map the previous `pdf-lib`
 * renderer used, converted from `rgb(0..1)` triples to hex so it can be handed
 * to `@react-pdf/renderer` stylesheets — the document keeps the look it had,
 * only the layout engine changed.
 *
 * The one addition is `SERIES` (see below), which the old renderer had no need
 * for because it could only draw a single-colour bar chart.
 */
import { StyleSheet } from '@react-pdf/renderer';

// ---------- Page geometry (A4, points) ----------

export const PAGE = {
  width: 595.28,
  height: 841.89,
  marginX: 44,
  /** Space reserved above the content for the fixed running header. */
  marginTop: 58,
  /** Space reserved below the content for the fixed running footer. */
  marginBottom: 46,
} as const;

/** Usable width between the page margins — the layout box every block fits in. */
export const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;

// ---------- Colour tokens ----------

export const COLOR = {
  text: '#1a1a1f',
  textMuted: '#6b7380',
  border: '#e0e3eb',
  borderStrong: '#c9cedb',
  cardBg: '#f7fafc',
  surface: '#ffffff',
  accent: '#2963d9',

  pillPositiveFg: '#10a675',
  pillPositiveBg: '#e6f7ed',
  pillNegativeFg: '#db3b45',
  pillNegativeBg: '#fcebed',
  pillWarningFg: '#eb990d',
  pillWarningBg: '#fff5db',
  pillNeutralFg: '#6b7380',
  pillNeutralBg: '#f2f2f5',
  pillInfoFg: '#3d82ed',
  pillInfoBg: '#e8f2ff',

  priorityHigh: '#db3b45',
  priorityMedium: '#eb990d',
  priorityLow: '#3d82ed',

  quadrantTopBg: '#fcf0f0',
  quadrantBottomBg: '#f0f7ff',

  white: '#ffffff',
} as const;

/**
 * Categorical series colours, assigned by slot in fixed order and never cycled.
 *
 * This ordering is validated for colour-vision deficiency on a white surface:
 * worst adjacent-pair CVD separation is ΔE 9.1 (protan) and worst
 * adjacent-pair normal-vision separation is ΔE 19.6, both clear of the ≥8 /
 * ≥15 gates. Three slots (aqua, yellow, magenta) sit below 3:1 contrast
 * against white, which is why every multi-series chart in this document ships
 * a text legend and direct value labels — identity is never carried by colour
 * alone.
 *
 * Do not reorder, and do not generate a 9th colour: `seriesColor` folds
 * anything past slot 8 back to the muted ink so an over-long series list
 * degrades to "other" instead of inventing a hue.
 */
export const SERIES = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
] as const;

export function seriesColor(index: number): string {
  return SERIES[index] ?? COLOR.textMuted;
}

// ---------- Type scale ----------

export const FONT = {
  family: 'Inter',
  title: 19,
  section: 13,
  subsection: 11,
  body: 9.5,
  small: 8,
  tiny: 7,
} as const;

export const LINE = {
  body: 1.45,
  tight: 1.3,
} as const;

/**
 * Font size and line height, declared together.
 *
 * Always spread this rather than writing the two properties by hand, because
 * `@react-pdf/stylesheet` resolves `lineHeight` in a way that punishes both
 * obvious shortcuts:
 *
 *   - A unitless number is a **multiplier**, applied to `style.fontSize` on the
 *     SAME style object — falling back to 18 when that object does not declare
 *     one. So `{ lineHeight: 1.3 }` on a `<Text>` that inherits 9.5pt yields
 *     23.4pt of leading, not 12.4pt.
 *   - Passing the product instead does not help: a bare `24.7` is read as a
 *     multiplier too, giving 469pt of leading. A line taller than the page body
 *     can never be placed, and the paginator spins forever.
 *
 * (An absolute value is only expressible as a string with a unit — `'24.7pt'`.
 * Pairing size and multiple is clearer, so that is what this returns.)
 */
export function typeStyle(size: number, multiple: number = LINE.body) {
  return { fontSize: size, lineHeight: multiple };
}

// ---------- Shared stylesheet ----------

export const styles = StyleSheet.create({
  page: {
    paddingTop: PAGE.marginTop,
    paddingBottom: PAGE.marginBottom,
    paddingHorizontal: PAGE.marginX,
    fontFamily: FONT.family,
    ...typeStyle(FONT.body),
    color: COLOR.text,
    backgroundColor: COLOR.surface,
  },

  // Running header / footer
  header: {
    position: 'absolute',
    top: 22,
    left: PAGE.marginX,
    right: PAGE.marginX,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR.border,
  },
  // `flex: 1` so this side claims the space the right-hand label does not use.
  // Left at `flexShrink` it sizes to content, and since the title inside it has
  // a zero flex-basis, "content" collapses to nothing and the title ellipsizes
  // after one word.
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, paddingRight: 10 },
  headerLogo: { height: 11, marginRight: 7 },
  headerTitle: {
    ...typeStyle(FONT.tiny, LINE.tight),
    color: COLOR.textMuted,
    flex: 1,
    // The header is a fixed-height absolute band sharing a row with the label
    // on the right. A title allowed to wrap would grow into it.
    maxLines: 1,
    textOverflow: 'ellipsis',
  },
  headerRight: { fontSize: FONT.tiny, color: COLOR.textMuted, flexShrink: 0 },
  // Two deliberate departures from the obvious styling, both of them
  // workarounds for the same upstream weakness: `@react-pdf/renderer` cannot
  // measure an absolutely positioned node whose content is re-rendered per
  // page by a `render` prop — which the page counter below makes this one.
  //
  //   1. Anchored by `top`, not `bottom`. Bottom-anchoring produces a y of
  //      about -3.6e21 that pdfkit rejects with "unsupported number".
  //   2. No `alignItems: 'center'`. Cross-axis centring needs a resolved
  //      height, and the re-render leaves it unresolved — same crash.
  //
  // Both children carry the same font size, so the default cross-axis start
  // alignment already lines them up.
  footer: {
    position: 'absolute',
    top: PAGE.height - 32,
    left: PAGE.marginX,
    right: PAGE.marginX,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 0.5,
    borderTopColor: COLOR.border,
  },
  footerText: { fontSize: FONT.tiny, color: COLOR.textMuted, flexShrink: 1 },
  footerPage: { fontSize: FONT.tiny, color: COLOR.textMuted, flexShrink: 0 },

  // Title block
  titleBlock: { marginBottom: 14 },
  title: {
    ...typeStyle(FONT.title, LINE.tight),
    fontWeight: 700,
    color: COLOR.text,
  },
  subtitle: { fontSize: FONT.small, color: COLOR.textMuted, marginTop: 5 },

  // Headings
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    marginBottom: 6,
  },
  sectionAccentBar: {
    width: 2.5,
    alignSelf: 'stretch',
    minHeight: 13,
    backgroundColor: COLOR.accent,
    marginRight: 7,
  },
  sectionHeadingText: {
    ...typeStyle(FONT.section, LINE.tight),
    fontWeight: 700,
    // `flex: 1`, not `flexShrink: 1`. A row child keeps its max-content
    // flex-basis under flexShrink alone, so a heading longer than the line
    // overruns the margin instead of wrapping.
    flex: 1,
  },
  subsectionHeadingText: {
    ...typeStyle(FONT.subsection, LINE.tight),
    fontWeight: 600,
    marginTop: 10,
    marginBottom: 4,
  },

  // Text blocks
  paragraph: { marginBottom: 6 },
  bulletRow: { flexDirection: 'row', marginBottom: 3 },
  bulletDot: { width: 10, flexShrink: 0, color: COLOR.textMuted },
  bulletText: { flex: 1 },
  muted: { color: COLOR.textMuted },

  // Generic block spacing
  block: { marginBottom: 8 },
});
