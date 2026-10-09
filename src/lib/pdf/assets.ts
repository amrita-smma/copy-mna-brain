import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/**
 * Remote image loading for the research-summary PDF.
 *
 * `@react-pdf/renderer` can take a URL directly in `<Image src>`, but then the
 * fetch happens inside the layout pass: one slow or hanging host stalls the
 * whole render, and a 404 throws out of `renderToBuffer` and loses the email.
 * Every remote image is therefore resolved up front, under a timeout, and a
 * failure resolves to `undefined` so the block renders without it.
 *
 * The URLs here come from a language model, and the fetch runs server-side with
 * whatever network reach the function has. That makes this an SSRF surface, so
 * the address is checked before the request and again after every redirect.
 */

/** Formats `@react-pdf/renderer` can decode. SVG is not among them. */
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

/** A logo that misses this budget is not worth delaying an email for. */
export const IMAGE_TIMEOUT_MS = 4_000;

/**
 * Per-image byte cap. Logos are small; anything larger is a hero image someone
 * pointed at by mistake, and 25 of them would blow the SES attachment limit.
 */
export const MAX_IMAGE_BYTES = 512 * 1024;

/**
 * Ceiling on how many distinct images one document may fetch, and how many may
 * be in flight at once. A spec with hundreds of scorecard rows would otherwise
 * open hundreds of sockets and hold hundreds of buffers.
 */
export const MAX_IMAGES_PER_DOCUMENT = 32;
const FETCH_CONCURRENCY = 6;

/** Redirect hops followed before giving up. */
const MAX_REDIRECTS = 3;

export type ImageCache = Map<string, Buffer | undefined>;

/**
 * Hostnames that must never be reached from the server.
 *
 * Covers loopback, the link-local range that carries cloud instance metadata,
 * RFC1918 and carrier-grade NAT, plus the internal-sounding suffixes. This is a
 * pre-connect check on the literal address, so it stops the obvious cases and a
 * redirect into them; it cannot stop DNS rebinding, which would need the socket
 * to be pinned to a vetted IP and is beyond what `fetch` exposes.
 */
/**
 * The dotted-quad inside an IPv4-mapped IPv6 address, or `undefined`.
 *
 * `new URL()` normalises `::ffff:127.0.0.1` to `::ffff:7f00:1`, so the mapped
 * address has to be recovered from the trailing 32 bits rather than matched as
 * text — otherwise loopback reaches the network wearing an IPv6 hat.
 */
function ipv4Mapped(host: string): string | undefined {
  if (!host.startsWith('::ffff:')) return undefined;
  const tail = host.slice('::ffff:'.length);
  if (tail.includes('.')) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2) return undefined;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true;
  }

  const version = net.isIP(host);
  if (version === 0) return false;

  if (version === 6) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true;
    const mapped = ipv4Mapped(host);
    return mapped ? isBlockedHost(mapped) : false;
  }

  const [a, b] = host.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** An https/http URL that does not point at the server's own network. */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !isBlockedHost(url.hostname);
}

function extensionType(url: string): string | undefined {
  const pathname = url.split('?')[0].toLowerCase();
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  return undefined;
}

/**
 * Read the body, abandoning it as soon as it exceeds the cap.
 *
 * `res.arrayBuffer()` would buffer the whole response first and only then let
 * us measure it, so a server that sends no `content-length` could commit
 * unbounded memory before the limit was ever consulted.
 */
async function readCapped(res: Response): Promise<Buffer | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return total === 0 ? undefined : Buffer.concat(chunks, total);
}

/**
 * Fetch one image. Returns `undefined` — never throws — for every failure mode:
 * a blocked or malformed URL, a non-2xx response, too many redirects, a
 * disallowed or unknown content type, an oversized body, a timeout, or a
 * transport error.
 */
export async function loadImage(url: string): Promise<Buffer | undefined> {
  if (!isFetchableUrl(url)) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Redirects are followed by hand so each hop's address is checked;
      // `redirect: 'follow'` would land on an internal host unexamined.
      const res = await fetch(current, { signal: controller.signal, redirect: 'manual' });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return undefined;
        const next = new URL(location, current).toString();
        if (!isFetchableUrl(next)) return undefined;
        current = next;
        continue;
      }

      if (!res.ok) return undefined;

      // Some CDNs serve logos as `application/octet-stream`; fall back to the
      // extension so those still render, but never accept a type we cannot
      // decode.
      const header = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const type = ALLOWED_TYPES.has(header) ? header : extensionType(current);
      if (!type) return undefined;

      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return undefined;

      return await readCapped(res);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve every distinct URL once, a few at a time.
 *
 * De-duplicating first matters: a scorecard listing the same company in several
 * rows would otherwise fetch its logo once per row — the request fan-out this
 * repo's N+1 rule exists to prevent, in its HTTP form. The concurrency cap and
 * the document-wide ceiling bound the rest: a spec is free to name more images
 * than that, and the ones past the ceiling simply do not render.
 */
export async function loadImages(urls: Array<string | null | undefined>): Promise<ImageCache> {
  const unique = Array.from(
    new Set(urls.filter((u): u is string => typeof u === 'string' && u.length > 0)),
  ).slice(0, MAX_IMAGES_PER_DOCUMENT);

  const cache: ImageCache = new Map();
  if (unique.length === 0) return cache;

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= unique.length) return;
      cache.set(unique[index], await loadImage(unique[index]));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, unique.length) }, worker),
  );

  return cache;
}

/** Read the app logo off disk for the running header; `undefined` if absent. */
export function loadLocalLogo(): Buffer | undefined {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'public', 'logo-light.png'));
  } catch {
    return undefined;
  }
}
