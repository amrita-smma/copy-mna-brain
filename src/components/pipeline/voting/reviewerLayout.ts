/**
 * Width heuristics for the verbatim reviewer columns.
 *
 * The feedback card lays the reviewers out as one flex row (4–5 of them is the
 * design target). A flex row is as tall as its tallest card, so a reviewer who
 * writes five paragraphs next to four who wrote one line sets the height of the
 * whole card and strands the short ballots above a column of whitespace.
 * Rather than clipping or scrolling that long rationale, we give it a wider
 * column: more characters per line means fewer lines, which pulls the row's
 * height back down toward the short ballots and evens out the leftover space.
 */

/**
 * Rationales below this are all "short" — a 12-character ballot gets the same
 * column as a 130-character one instead of being squeezed to a ribbon.
 */
const FLOOR_CHARS = 140;

/** The widest column may be at most this many times the narrowest. */
const MAX_RATIO = 2.2;

/**
 * Length of the text a reviewer actually wrote, ignoring the markup the
 * WYSIWYG editor wraps it in. Tags contribute nothing to how many lines the
 * rationale renders as, so counting them would hand a wide column to whoever
 * used the most bullet points.
 */
export function plainTextLength(html: string | null | undefined): number {
  if (!html) return 0;
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/**
 * Relative column widths for a row of reviewers, as flex-grow factors on
 * `flex-basis: 0` cards — a weight of 2 means twice the width of a weight of 1.
 *
 * Growth is square-root rather than linear: text set twice as wide only needs
 * ~half the lines, so width should track the square root of the character
 * count, and a rationale ten times longer than its neighbour's has no business
 * taking ten times the row. The result is clamped to {@link MAX_RATIO} so the
 * short ballots keep a readable measure no matter how long the outlier runs.
 */
export function reviewerColumnWeights(lengths: number[]): number[] {
  if (lengths.length === 0) return [];
  const raw = lengths.map((length) =>
    Math.sqrt(Math.max(Number.isFinite(length) ? length : 0, FLOOR_CHARS)),
  );
  const narrowest = Math.min(...raw);
  return raw.map((value) =>
    Math.round(Math.min(value / narrowest, MAX_RATIO) * 100) / 100,
  );
}
