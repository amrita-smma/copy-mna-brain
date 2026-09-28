export interface LruCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
}

/** The hover-preview cache: HTML strings keyed by insight or template id. */
export type HtmlPreviewCache = LruCache<string>;

/**
 * A small in-memory LRU cache.
 *
 * Capped so it can't grow unbounded — scrolling through a long insight/template
 * list on the client, or a long-lived server process memoising per-version
 * derivations (see `InsightService.getChatContext`). Never persisted (no
 * localStorage): a hover preview going stale the moment the underlying
 * document changes is fine for a peek, and isn't worth the staleness bugs a
 * persisted cache would introduce.
 */
export function createLruCache<V = string>(maxEntries: number): LruCache<V> {
  const map = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as V;
      // Touch: re-insert so this key becomes the most recently used.
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: string, value: V): void {
      map.delete(key);
      map.set(key, value);
      if (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
  };
}
