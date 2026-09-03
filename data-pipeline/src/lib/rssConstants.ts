/**
 * Dependency-free constants shared across the RSS lake.
 *
 * This file must import nothing. `MAX_CONTENT_ATTEMPTS` used to live in
 * `rssContent.ts`, which pulls in `@extractus/article-extractor` (and
 * transitively `linkedom` / the native `canvas` module) — fine for the
 * rss-enrich Lambda, which genuinely parses HTML, but `rssRepository.ts`
 * only needed the integer, not the parser. Because `rssRepository.ts` is
 * re-exported through the shared `repositories/index.ts` barrel, that one
 * import was enough to drag article-extractor into every Lambda that
 * touches any repository — including the two email Lambdas, which never
 * parse HTML. Keeping this constant here, with zero imports, lets
 * `rssRepository.ts` depend on it without pulling in the parser stack.
 */
export const MAX_CONTENT_ATTEMPTS = 3;

/**
 * Translation attempts before an item is given up on. Same shape and reason
 * as `MAX_CONTENT_ATTEMPTS`: a transient model outage must not permanently
 * strand an item, but a body the model keeps refusing must eventually stop
 * being re-queued. On exhaustion the item stays fully readable in its
 * original language and is embedded from that text.
 */
export const MAX_TRANSLATION_ATTEMPTS = 3;
