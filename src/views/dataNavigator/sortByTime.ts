import type { NewsItem } from '@/lib/api/dataNavigator';

/**
 * Newest first, undated last.
 *
 * The feed endpoint already returns `published_at DESC NULLS LAST`, so this is
 * a no-op there. It exists for the search branch, whose hits arrive ranked by
 * hybrid relevance score — relevance decides *which* items come back, this
 * decides the order they are read in, so the pane always reads chronologically
 * regardless of how the list was produced.
 *
 * Returns a new array; never mutates the input.
 */
export function sortByPublishedDesc<T extends Pick<NewsItem, 'published_at' | 'id'>>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const at = a.published_at ? Date.parse(a.published_at) : Number.NaN;
    const bt = b.published_at ? Date.parse(b.published_at) : Number.NaN;
    const aInvalid = Number.isNaN(at);
    const bInvalid = Number.isNaN(bt);
    // Undated (or unparseable) rows sink below every dated row, matching the
    // NULLS LAST ordering the feed query uses.
    if (aInvalid && bInvalid) return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    if (aInvalid) return 1;
    if (bInvalid) return -1;
    if (at !== bt) return bt - at;
    // Stable tiebreak on id so equal timestamps never reshuffle between renders.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
