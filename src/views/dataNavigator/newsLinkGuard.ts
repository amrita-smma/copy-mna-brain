/**
 * Whether `link` is safe to render as an anchor `href`. Ingest
 * (`data-pipeline/src/handlers/rssNormalize.ts`) already rejects non-http(s)
 * links for new rows, but this guards existing rows too — a `javascript:`
 * or `data:` URI rendered raw as a link would otherwise become a
 * script/phishing navigation on click. Kept dependency-free (no DOM/React)
 * so it can be unit-tested without a browser test environment.
 */
export function isSafeHttpUrl(link: string): boolean {
  try {
    const parsed = new URL(link);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
