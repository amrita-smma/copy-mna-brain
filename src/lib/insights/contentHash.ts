import { createHash } from 'crypto';

/**
 * The form of an insight's HTML that its content hash is taken over: every run
 * of whitespace collapsed to one space, then trimmed. A refresh that only
 * reflows the document (re-indents, adds a trailing newline) therefore hashes
 * the same as the version it started from and is recorded as unchanged.
 */
export function normalizeInsightHtml(html: string): string {
  return html.replace(/\s+/g, ' ').trim();
}

/** sha256 (hex) of the normalised HTML. Stored on every insight version. */
export function insightContentHash(html: string): string {
  return createHash('sha256').update(normalizeInsightHtml(html), 'utf8').digest('hex');
}

/**
 * Whether two stored hashes denote the same content. A null hash (a version
 * written before hashes existed) is never equal to anything, so an old
 * version can't make a real change look unchanged.
 */
export function sameInsightContent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}
