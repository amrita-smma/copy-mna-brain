/** Where the OAuth round-trip lands when no usable `returnTo` was given. */
export const DEFAULT_RETURN_PATH = '/workspace';

/** The query param the Profile card reads to toast the outcome. */
export const RESULT_PARAM = 'meetingIntelligence';

/**
 * An in-app path to send the member back to after connecting, or the default.
 * Only same-origin absolute paths are accepted (`/w/acme/profile`), never a
 * protocol-relative `//evil.com` or a full URL — the value round-trips through
 * the browser, so it must not become an open redirect.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return DEFAULT_RETURN_PATH;
  }
  if (/[\u0000-\u001f]/.test(value)) return DEFAULT_RETURN_PATH;
  return value;
}

/** `returnTo` on `origin` with the outcome (`connected` / `error`) appended. */
export function resultUrl(
  origin: string,
  returnTo: string,
  outcome: 'connected' | 'error',
  reason?: string,
): URL {
  const url = new URL(safeReturnPath(returnTo), origin);
  if (url.origin !== origin) return new URL(DEFAULT_RETURN_PATH, origin);
  url.searchParams.set(RESULT_PARAM, outcome);
  if (reason) url.searchParams.set(`${RESULT_PARAM}Reason`, reason.slice(0, 200));
  return url;
}
