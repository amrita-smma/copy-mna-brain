/**
 * Full-article text extraction for LLM-selected items.
 *
 * Only the selected subset (~75/day) is fetched, so this is polite by
 * construction. Paywalled and robots-blocked pages simply fail and exhaust
 * their attempt budget — nothing here attempts to circumvent access controls.
 */
import { extract, type Fetcher } from '@extractus/article-extractor';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
// Re-exported for existing importers. The canonical definition lives in
// `rssConstants.ts` (dependency-free) so `rssRepository.ts` can depend on the
// constant without pulling in article-extractor/linkedom/canvas — see that
// file's docstring for why this split exists.
export { MAX_CONTENT_ATTEMPTS } from './rssConstants';

export const CONTENT_TIMEOUT_MS = 15_000;
/** Hard cap on stored article text. Long-read features rarely exceed ~60 KB. */
export const CONTENT_MAX_BYTES = 200_000;
/**
 * Below this, the "article" is almost certainly a paywall or consent screen.
 * This is the *only* length guard in effect: `contentLengthThreshold: 0`
 * below deliberately disables the extractor's own upstream length screen, so
 * dropping this constant would let paywall/cookie-banner stubs ("Subscribe
 * to continue reading...", "Accept cookies to continue...") pass through as
 * if they were real article text.
 */
const MIN_USEFUL_LENGTH = 200;

export type ContentOutcome = { kind: 'ok'; text: string } | { kind: 'failed'; reason: string };

export interface ContentDeps {
  extract?: (url: string, options?: unknown) => Promise<{ content?: string } | null>;
  timeoutMs?: number;
  /** Test seam: inject a fake `fetch` for the SSRF-hardened fetcher below, so tests need no real network/DNS. */
  fetch?: typeof fetch;
}

export async function fetchArticleContent(
  url: string,
  deps: ContentDeps = {},
): Promise<ContentOutcome> {
  if (!/^https?:\/\//i.test(url)) return { kind: 'failed', reason: 'unsupported url scheme' };

  const timeoutMs = deps.timeoutMs ?? CONTENT_TIMEOUT_MS;

  try {
    const article = await runExtractor(url, deps, timeoutMs);
    if (!article?.content) return { kind: 'failed', reason: 'no article extracted' };

    const text = toPlainText(article.content);
    if (text.length < MIN_USEFUL_LENGTH) return { kind: 'failed', reason: 'content too short' };

    return { kind: 'ok', text: text.slice(0, CONTENT_MAX_BYTES) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', reason: reason.slice(0, 200) };
  }
}

/**
 * Runs the extractor and bounds it by `timeoutMs`.
 *
 * The installed extractor's `ParserOptions` has no `timeout` field, so the
 * deadline can't be passed through as a parser option. For the real
 * extractor (no injected `deps.extract`) we instead supply a custom
 * `Fetcher` that races the underlying HTTP request against an
 * `AbortController`, so a slow publisher genuinely has its connection torn
 * down rather than merely being ignored while the request keeps running in
 * the background. The outer `withTimeout` race remains as a backstop for
 * time spent outside the fetch itself (e.g. Readability parsing) and as the
 * only bound available for the injected `deps.extract` test seam, which has
 * no fetcher hook to cancel.
 */
function runExtractor(
  url: string,
  deps: ContentDeps,
  timeoutMs: number,
): Promise<{ content?: string } | null> {
  const options = { descriptionTruncateLen: 0, contentLengthThreshold: 0 };

  if (deps.extract) {
    return withTimeout(deps.extract(url, options), timeoutMs);
  }

  return withTimeout(
    extract(url, options, createSafeFetcher(timeoutMs, deps.fetch)),
    timeoutMs,
  );
}

/**
 * A `Fetcher` (see `@extractus/article-extractor`) that aborts the in-flight
 * request at `timeoutMs` AND hardens every hop of the request against SSRF
 * (see `fetchWithRedirectGuard` below for the actual guard).
 */
function createSafeFetcher(timeoutMs: number, fetchImpl?: typeof fetch): Fetcher {
  return (fetchUrl: string) => fetchWithRedirectGuard(fetchUrl, timeoutMs, fetchImpl ?? fetch);
}

/** Hard cap on redirect hops a single fetch will follow before giving up. */
const MAX_REDIRECT_HOPS = 5;

const BLOCKED_HOSTNAME_SUFFIXES = ['.internal', '.local'];

/** IPv4 dotted-quad -> 32-bit unsigned integer, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function inIpv4Range(ip: string, base: string, prefixLength: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// Private, loopback, link-local, and cloud-metadata IPv4 ranges. 169.254.0.0/16
// covers the 169.254.169.254 EC2/VPC instance-metadata endpoint specifically.
const BLOCKED_IPV4_RANGES: Array<[base: string, prefixLength: number]> = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
];

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, prefixLength]) => inIpv4Range(ip, base, prefixLength));
}

/**
 * Rewrites a trailing embedded-IPv4 tail (e.g. the address ending in
 * `...:169.254.169.254`) into two hex hextets, so `expandIpv6` below only
 * ever has to deal with pure-hex groups. A no-op when there's no dotted
 * tail. Returns null if the trailing dotted-quad itself is malformed.
 */
function inlineIpv4Tail(address: string): string | null {
  const match = address.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (!match) return address;

  const ipv4Int = ipv4ToInt(match[1]);
  if (ipv4Int === null) return null;

  const high = ((ipv4Int >>> 16) & 0xffff).toString(16);
  const low = (ipv4Int & 0xffff).toString(16);
  return address.slice(0, address.length - match[1].length) + `${high}:${low}`;
}

/**
 * Fully expands an IPv6 address string into its 8 constituent 16-bit
 * hextets (as numbers), resolving `::` compression and any embedded IPv4
 * tail, so every check below reasons about a canonical 8-group form
 * instead of inferring structure from string positions.
 *
 * This replaces an earlier, broken version that pulled the "first hextet"
 * via `address.split(':')[0]`. That silently breaks for any address
 * compressed with a *leading* `::` (e.g. `::ffff:a9fe:a9fe`, the
 * IPv4-mapped form the WHATWG `URL` parser normalizes
 * `::ffff:169.254.169.254` into): `split(':')[0]` on a string starting
 * with `::` is `''`, which the old code's `|| '0'` fallback silently
 * turned into hextet zero — indistinguishable from a real all-zero
 * address — instead of signaling "this is compression, expand it first."
 * Returns null for a malformed address (caller fails closed on null).
 */
function expandIpv6(rawAddress: string): number[] | null {
  const address = inlineIpv4Tail(rawAddress);
  if (address === null) return null;

  const halves = address.split('::');
  if (halves.length > 2) return null; // '::' may appear at most once

  const head = halves[0] ? halves[0].split(':').filter((g) => g.length > 0) : [];
  const tail =
    halves.length === 2 && halves[1] ? halves[1].split(':').filter((g) => g.length > 0) : [];

  let groups: string[];
  if (halves.length === 2) {
    const zeroCount = 8 - head.length - tail.length;
    if (zeroCount < 0) return null;
    groups = [...head, ...Array(zeroCount).fill('0'), ...tail];
  } else {
    // No '::' at all — the address must already spell out all 8 groups.
    groups = head;
  }
  if (groups.length !== 8) return null;

  const hextets: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    hextets.push(parseInt(group, 16));
  }
  return hextets;
}

function isBlockedIpv6(ip: string): boolean {
  const hextets = expandIpv6(ip.toLowerCase());
  // Fail closed: an IPv6 literal/DNS answer this parser can't make sense of
  // is treated as blocked rather than handed to fetch() unexamined.
  if (!hextets) return true;

  // IPv4-mapped (::ffff:0:0/96) — covers BOTH spellings of a mapped
  // metadata address, since the WHATWG URL parser normalizes the dotted
  // form (`::ffff:169.254.169.254`) into the hex form (`::ffff:a9fe:a9fe`)
  // and both expand to the same 8 hextets here. Re-run the embedded 32
  // bits through the already-correct IPv4 blocklist rather than
  // duplicating those ranges for IPv6.
  const isMappedV4 = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (isMappedV4) {
    const a = (hextets[6] >> 8) & 0xff;
    const b = hextets[6] & 0xff;
    const c = (hextets[7] >> 8) & 0xff;
    const d = hextets[7] & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }

  const isLoopback = hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;
  if (isLoopback) return true; // ::1

  if ((hextets[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
  if ((hextets[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

function isBlockedAddress(address: string, family: number): boolean {
  return family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

/** Strips the `[...]` brackets the WHATWG `URL` parser puts around an IPv6 host. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Resolves `hostname` and reports whether ANY resulting address is private,
 * loopback, link-local, or a cloud-metadata range — or whether the hostname
 * itself is a name we always treat as internal (`localhost`, `*.internal`,
 * `*.local`) regardless of what it resolves to.
 *
 * Fails closed: a hostname that cannot be resolved is treated as blocked
 * rather than allowed through, since letting an unresolvable host proceed to
 * `fetch()` would just push the same decision onto the OS resolver with no
 * chance to inspect the result first.
 *
 * NOTE — this check and the `fetch()` that follows it are not atomic. A
 * DNS-rebinding attacker can serve a public address to this lookup and a
 * private one to the connection `fetch()` itself performs a moment later.
 * That race is real and is NOT closed by this check; it is accepted here
 * because this fetch path only ever runs against a small, LLM-curated
 * subset of feed links (~75/day), not arbitrary user input. Closing it for
 * real requires resolving once and connecting to the resolved IP directly
 * (e.g. a custom `dns.lookup` on the HTTP agent), which is out of scope for
 * this fix.
 */
async function resolvesToBlockedAddress(rawHostname: string): Promise<boolean> {
  const hostname = stripBrackets(rawHostname).toLowerCase();
  if (hostname === 'localhost') return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;

  const literalFamily = net.isIP(hostname);
  if (literalFamily) return isBlockedAddress(hostname, literalFamily);

  try {
    const addresses = await dnsLookup(hostname, { all: true });
    return addresses.some((a) => isBlockedAddress(a.address, a.family));
  } catch {
    return true;
  }
}

/** Thrown by `assertAllowedUrl` — always caught and turned into a `{ kind: 'failed' }` outcome, never surfaced raw. */
class BlockedUrlError extends Error {}

async function assertAllowedUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedUrlError('malformed url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedUrlError('unsupported url scheme');
  }
  if (await resolvesToBlockedAddress(parsed.hostname)) {
    throw new BlockedUrlError('blocked host');
  }
}

/**
 * SSRF-hardened, redirect-following fetch. This is the seam
 * `createSafeFetcher` wires into the article extractor: it exists (rather
 * than relying on the default `redirect: 'follow'`) so that EVERY hop of a
 * redirect chain — not just the caller-supplied starting URL — gets
 * re-validated by `assertAllowedUrl` before being requested. A feed-supplied
 * `link` can look like an innocuous `https://` URL and still redirect to
 * `169.254.169.254` (cloud instance metadata) or an internal host; without
 * per-hop validation that redirect would be followed silently and its body
 * would end up persisted as if it were the public article.
 *
 * Exported for direct unit testing with an injected `fetchImpl` — no real
 * network or DNS involved.
 */
export async function fetchWithRedirectGuard(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    await assertAllowedUrl(currentUrl);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('extraction timed out');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, { signal: controller.signal, redirect: 'manual' });
    } finally {
      clearTimeout(timer);
    }

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = isRedirect ? response.headers.get('location') : null;
    if (!location) return response;

    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error('too many redirects');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('extraction timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function toPlainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    // Block-level tags become paragraph breaks so the chunker has real boundaries.
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
