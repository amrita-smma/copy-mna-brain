/**
 * Deeplink preservation across the logged-out login bounce.
 *
 * Hitting a protected URL without a session redirects to `/login`; without the
 * intended destination riding along, the user lands on `/workspace` (or their
 * default workspace's chat) and has to navigate back by hand — which for an
 * emailed or bookmarked deeplink means the link effectively didn't work.
 *
 * Every gate that bounces to `/login` builds its URL with
 * `loginUrlWithCallback`, and the login page reads it back with
 * `sanitizeCallbackUrl`. The param name matches the one NextAuth itself
 * appends when it redirects to `pages.signIn`, so those bounces are preserved
 * for free.
 *
 * Both directions sanitize: this value arrives from a URL the user (or
 * whoever wrote the link) controls, and it ends up in a redirect `Location`,
 * so an unvalidated value is an open redirect.
 */

export const CALLBACK_URL_PARAM = 'callbackUrl';

/** Parsed against a throwaway origin — a value that escapes it isn't same-origin. */
const PLACEHOLDER_ORIGIN = 'https://callback.invalid';

/** Destinations the post-login default already lands on — nothing to preserve. */
const REDUNDANT_DESTINATIONS = new Set(['/', '/workspace']);

/**
 * Whether `value` would leave this origin once a browser resolves it — as a
 * redirect `Location` or handed to the Next router. Anything not rooted at a
 * single `/`, which covers protocol-relative `//host` and its `/\host` variant
 * (every major browser normalizes the two to the same thing).
 */
function escapesOrigin(value: string): boolean {
  return !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\');
}

/**
 * Control characters (NUL/CR/LF/TAB...) are stripped or normalized
 * inconsistently by browsers, so a value carrying them can mean something
 * different to the browser than it does to the prefix checks.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Whether `value`, and the form it takes after a single percent-decode, are
 * both safely same-origin.
 *
 * The second check is what stops percent-encoding from smuggling a host past
 * `escapesOrigin`: `/%5Cevil.example` and `/%2F%2Fevil.example` stay
 * same-origin under WHATWG `Location` resolution as-is, but decode to `/\…`
 * and `///…` — so any consumer that decodes once before redirecting would turn
 * them into open redirects. Cheaper to reject them here than to depend on
 * nobody ever adding that decode.
 */
function isSafeSameOriginPath(value: string): boolean {
  if (CONTROL_CHARS.test(value) || escapesOrigin(value)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false; // Malformed percent-encoding — can't reason about it.
  }
  return !CONTROL_CHARS.test(decoded) && !escapesOrigin(decoded);
}

/**
 * Normalizes a caller-supplied destination to a safe same-origin path, or
 * returns null when it isn't one.
 *
 * Rejects anything that isn't a plain same-origin path (see
 * `isSafeSameOriginPath`, applied to both the input and the assembled result),
 * the login page itself (which would loop), and `/api/*` (never a place to land
 * a browser). Strips the SSO `token` param, which `proxy.ts` consumes exactly
 * once and must not be replayed.
 */
export function sanitizeCallbackUrl(raw: string | null | undefined): string | null {
  if (!raw || !isSafeSameOriginPath(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  // Belt-and-braces: anything that resolved off the placeholder origin escaped
  // the checks above.
  if (parsed.origin !== PLACEHOLDER_ORIGIN) return null;

  if (parsed.pathname === '/login' || parsed.pathname.startsWith('/login/')) return null;
  if (parsed.pathname.startsWith('/api/')) return null;

  parsed.searchParams.delete('token');
  const search = parsed.searchParams.toString();
  const result = `${parsed.pathname}${search ? `?${search}` : ''}${parsed.hash}`;

  // Re-check what we actually hand back, not just what came in — `URL`
  // normalization can shift the leading characters the checks above relied on.
  return isSafeSameOriginPath(result) ? result : null;
}

/**
 * The `/login` URL to bounce to, preserving `pathAndSearch` as the
 * post-login destination when it's safe and worth preserving.
 */
export function loginUrlWithCallback(pathAndSearch: string | null | undefined): string {
  const destination = sanitizeCallbackUrl(pathAndSearch);
  if (!destination || REDUNDANT_DESTINATIONS.has(destination)) return '/login';
  return `/login?${new URLSearchParams({ [CALLBACK_URL_PARAM]: destination }).toString()}`;
}
