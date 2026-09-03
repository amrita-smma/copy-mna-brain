/**
 * Which language a news item is *displayed* in.
 *
 * The enrich pipeline stores a non-English item twice: the original text in
 * `title` / `summary` / `content_text`, and Haiku's English rendering in the
 * parallel `*_en` columns (see `data-pipeline/src/handlers/rssTranslate.ts`).
 * Nothing is overwritten, so the reading pane can offer "display in original
 * language" — which means every render site needs one shared answer to "which
 * of the two do I show, and is what I'm showing a translation?".
 *
 * Pure functions rather than a hook: the news list has no toggle (it always
 * shows English, since a foreign headline is unreadable to someone scanning
 * the feed) while the preview does, and both must agree about what counts as
 * translated.
 */

/** The subset of a news row these helpers read — satisfied by both the list projection and the full detail row. */
export interface TranslatedFields {
  title: string;
  summary: string | null;
  language: string | null;
  translation_status: string;
  title_en: string | null;
  summary_en: string | null;
  /** Absent on the list projection, which omits both body columns by design. */
  content_text?: string | null;
  content_text_en?: string | null;
}

/**
 * Whether an English rendering exists to show.
 *
 * Checks `title_en` rather than trusting `translation_status` alone: a row
 * could in principle be marked `translated` with a null title (a partial
 * write, or a hand-edited row), and rendering an empty headline is worse than
 * rendering a foreign one. The title is the field every surface needs, so it
 * is the one that defines "has a translation".
 */
export function hasTranslation(item: TranslatedFields): boolean {
  return item.translation_status === 'translated' && (item.title_en?.trim() ?? '') !== '';
}

/** Headline to render. `showOriginal` is ignored when there is no translation. */
export function displayTitle(item: TranslatedFields, showOriginal = false): string {
  if (showOriginal || !hasTranslation(item)) return item.title;
  return item.title_en ?? item.title;
}

/**
 * Summary to render, or null when the item never carried one.
 *
 * Falls back to the original when the item is translated but its summary
 * happened not to be — an item whose feed entry had no summary at all, for
 * instance. Showing the original beats showing nothing.
 */
export function displaySummary(item: TranslatedFields, showOriginal = false): string | null {
  if (showOriginal || !hasTranslation(item)) return item.summary;
  return item.summary_en ?? item.summary;
}

/** Article body to render, or null when no body was ever extracted. */
export function displayBody(item: TranslatedFields, showOriginal = false): string | null {
  if (showOriginal || !hasTranslation(item)) return item.content_text ?? null;
  return item.content_text_en ?? item.content_text ?? null;
}
