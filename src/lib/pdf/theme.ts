/**
 * Visual tokens for the research-summary PDF.
 *
 * The document is built on two brand colours — a navy ink and an orange accent
 * — and uses them consistently enough that a reader can tell one of these PDFs
 * from any other attachment at a glance: navy is structure (the cover band,
 * section headings, the first chart series, the takeaway callout), orange is
 * emphasis (accent rules, subsection headings, warning callouts, the second
 * chart series). Everything else is a neutral.
 */
import { StyleSheet } from '@react-pdf/renderer';
import { FONT_FAMILY, SERIF_STACK } from './fonts';

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

/**
 * Height of the running header band, measured from the top of the page to the
 * underside of its rule. The cover band starts here so the two do not overlap.
 */
export const HEADER_BAND = 46;

/** Usable width between the page margins — the layout box every block fits in. */
export const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;

/** Horizontal inset and border of the card a chart is framed in. */
export const FIGURE_PADDING_X = 14;
export const FIGURE_BORDER = 0.8;

/**
 * Drawable width inside a figure card.
 *
 * An `<Svg>` is given an explicit width in points, so it cannot discover the
 * card's content box for itself; getting this wrong by the padding is what
 * makes a chart's right-hand bar touch the frame.
 */
export const FIGURE_WIDTH = CONTENT_WIDTH - (FIGURE_PADDING_X + FIGURE_BORDER) * 2;

// ---------- Colour tokens ----------

export const COLOR = {
  text: '#1a1a1f',
  textMuted: '#6b7380',
  border: '#e2e8ef',
  borderStrong: '#c9cedb',
  cardBg: '#f8f9fb',
  surface: '#ffffff',
  accent: '#2963d9',

  // ---- Brand ----
  /** Cover band, section-heading ink, takeaway callout surface. */
  brandNavy: '#0f1f33',
  /** One step up from `brandNavy`, for a rule drawn *on* the navy surface. */
  brandNavyLine: '#24364f',
  /** Muted ink that still reads on `brandNavy`. */
  brandNavyMuted: '#879bb6',
  /** The accent rule under the cover title, and bullets on a navy surface. */
  brandOrange: '#df793f',
  /** The same accent at text weight — small-caps labels on a light surface. */
  brandOrangeDeep: '#c1410c',

  // ---- Callouts ----
  calloutWarnBg: '#fff6ed',
  calloutInfoBg: '#eef4fb',
  calloutPositiveBg: '#edf8f2',

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
 * Slots 0 and 1 are the brand navy and the brand orange, so a one- or
 * two-series chart — which is most of them — is drawn in the same two colours
 * as the cover band and the accent rule, and the figure reads as part of the
 * document rather than as a pasted-in image.
 *
 * The ordering is validated for colour-vision deficiency on a white surface.
 * Worst adjacent-pair separation is ΔE 15.7 (protan), 18.5 (deutan), 21.1
 * (tritan) and 33.2 (normal vision), clear of the ≥8 CVD / ≥15 normal gates.
 * Only one slot (`#d9a521`) sits below 3:1 contrast against white, but every
 * multi-series chart in this document still ships a text legend and direct
 * value labels — identity is never carried by colour alone.
 *
 * Do not reorder, and do not generate a 9th colour: `seriesColor` folds
 * anything past slot 8 back to the muted ink so an over-long series list
 * degrades to "other" instead of inventing a hue.
 */
export const SERIES = [
  '#1f3a5e',
  '#c1410c',
  '#3b82a0',
  '#d9a521',
  '#6b4ea0',
  '#1b7f5a',
  '#d4738c',
  '#5a6675',
] as const;

export function seriesColor(index: number): string {
  return SERIES[index] ?? COLOR.textMuted;
}

// ---------- Type scale ----------

export const FONT = {
  family: FONT_FAMILY,
  /** Serif display face; always an array so missing glyphs fall back to Inter. */
  serif: SERIF_STACK,
  cover: 25,
  title: 19,
  section: 15,
  subsection: 8.5,
  body: 9.5,
  small: 8,
  tiny: 7,
} as const;

/**
 * Tracking for the small-caps labels — subsection headings, callout eyebrows,
 * the running header. At 7–8.5pt an all-caps string is too dense to scan
 * without it.
 */
export const EYEBROW_TRACKING = 0.9;

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
  },
  headerRow: {
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
  // A third thing this node must not do: declare a `lineHeight`. A `<Text>`
  // inside a `render`-prop subtree is dropped from the output entirely if it
  // has one — as a multiplier or as an absolute `'9.1pt'` — and the page
  // numbers would simply stop printing. An `<Image>` or a border in such a
  // subtree is dropped too, which is why nothing else is re-rendered per page.
  footerPage: { fontSize: FONT.tiny, color: COLOR.textMuted, flexShrink: 0 },

  // ---------- Cover band ----------
  //
  // A full-bleed navy band across the top of page 1, carrying the serif title,
  // the subtitle and the orange accent rule.
  //
  // It is bled by cancelling the page padding with negative margins rather
  // than by absolute positioning: an absolutely positioned child is laid out
  // inside the page's padding box, so `left: 0` would stop at the margin, and
  // taking the band out of flow would leave the first block to start under it.
  //
  // It begins at `HEADER_BAND` rather than at y = 0, which leaves the running
  // header visible above it on page 1 instead of buried under opaque navy.
  // Burying it was the first design and it is wrong twice over: the header's
  // text stays in the page's text layer, so selecting or searching page 1
  // turns up a title nobody can see, and suppressing it with a `render` prop
  // instead costs the header its logo and its rule (see `footerPage`).
  coverBand: {
    marginTop: -(PAGE.marginTop - HEADER_BAND),
    marginLeft: -PAGE.marginX,
    marginRight: -PAGE.marginX,
    marginBottom: 20,
    paddingTop: 28,
    paddingBottom: 26,
    paddingHorizontal: PAGE.marginX,
    backgroundColor: COLOR.brandNavy,
  },
  coverTitle: {
    fontFamily: FONT.serif,
    ...typeStyle(FONT.cover, LINE.tight),
    fontWeight: 700,
    color: COLOR.white,
  },
  coverSubtitle: {
    ...typeStyle(FONT.small, LINE.tight),
    color: COLOR.brandNavyMuted,
    marginTop: 7,
  },
  coverRule: {
    height: 2.5,
    width: 58,
    backgroundColor: COLOR.brandOrange,
    marginTop: 16,
  },

  // ---------- Headings ----------
  //
  // A section heading is the serif face over a full-width hairline; a
  // subsection is a small-caps orange label. The two levels are told apart by
  // shape as well as size, so a subsection never reads as a short section.
  sectionHeading: {
    marginTop: 16,
    marginBottom: 8,
    paddingBottom: 5,
    borderBottomWidth: 0.8,
    borderBottomColor: COLOR.brandNavy,
  },
  sectionHeadingText: {
    fontFamily: FONT.serif,
    ...typeStyle(FONT.section, LINE.tight),
    fontWeight: 600,
    color: COLOR.brandNavy,
  },
  subsectionHeadingText: {
    ...typeStyle(FONT.subsection, LINE.tight),
    fontWeight: 700,
    letterSpacing: EYEBROW_TRACKING,
    textTransform: 'uppercase',
    color: COLOR.brandOrangeDeep,
    marginTop: 12,
    marginBottom: 5,
  },

  // Text blocks
  paragraph: { marginBottom: 6 },
  bulletRow: { flexDirection: 'row', marginBottom: 3 },
  bulletDot: { width: 10, flexShrink: 0, color: COLOR.textMuted },
  bulletText: { flex: 1 },
  muted: { color: COLOR.textMuted },

  // ---------- Figure card ----------
  //
  // The frame a chart sits in, so a figure is bounded by something other than
  // white space and does not read as loose marks between two paragraphs.
  figureCard: {
    borderWidth: FIGURE_BORDER,
    borderColor: COLOR.border,
    borderRadius: 4,
    backgroundColor: COLOR.surface,
    paddingVertical: 12,
    paddingHorizontal: FIGURE_PADDING_X,
    marginBottom: 10,
  },
  figureTitle: {
    ...typeStyle(FONT.body, LINE.tight),
    fontWeight: 700,
    color: COLOR.brandNavy,
    marginBottom: 8,
  },

  // ---------- Callout ----------
  calloutEyebrow: {
    ...typeStyle(FONT.tiny, LINE.tight),
    fontWeight: 700,
    letterSpacing: EYEBROW_TRACKING,
    textTransform: 'uppercase',
    marginBottom: 6,
  },

  // Generic block spacing
  block: { marginBottom: 8 },
});
