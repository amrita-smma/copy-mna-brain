/**
 * Iframe-embedding configuration and the launcher↔brain postMessage bridge.
 *
 * This brain (mna-tracker) can be embedded inside the Brain Launcher
 * (https://brain.starcapital.co.id, its staging peer, and localhost:3000)
 * as an `<iframe>`. Doing so cleanly requires three coordinated things, all
 * gated so the standalone deployment is unaffected:
 *   1. a `Content-Security-Policy: frame-ancestors ...` header permitting the
 *      launcher origins (see `next.config.ts`),
 *   2. cross-site auth cookies (`SameSite=None; Secure; Partitioned`, see
 *      `src/auth.config.ts`),
 *   3. a cross-origin messaging channel for logout propagation and re-auth
 *      (this module's `postToLauncher` + `src/components/iframe/IframeBridge`).
 *
 * This module is intentionally free of Node-only and React imports so it is
 * safe to import from server config (`next.config.ts`, `auth.config.ts`) and
 * client components alike. It only reads `process.env` and, where noted,
 * `window`.
 */

/** Launcher origins allowed to frame this app when no env override is set. */
const DEFAULT_ALLOWED_ANCESTORS = [
  'https://brain.starcapital.co.id',
  'https://brain-stg.starcapital.co.id',
  'http://localhost:3000',
];

/**
 * Master switch for the iframe posture. When `true`, the CSP header lists the
 * launcher origins and NextAuth cookies become `SameSite=None; Secure;
 * Partitioned`. When unset/`false`, the app keeps its standalone defaults
 * (`frame-ancestors 'self'`, `SameSite=Lax` cookies).
 */
export const IFRAME_EMBED_ENABLED = process.env.IFRAME_EMBED_ENABLED === 'true';

/**
 * Origins permitted to frame this app and to exchange postMessages with it.
 * Sourced from `NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS` (whitespace- or
 * comma-separated) so the same list is available on the server (CSP header)
 * and the client (postMessage origin allowlisting); falls back to the known
 * launcher origins. Trailing slashes are stripped so values compare cleanly
 * against `window.location.origin` / a message `event.origin`.
 */
export function getAllowedAncestorOrigins(): string[] {
  const raw = process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS;
  const list = raw
    ? raw
        .split(/[\s,]+/)
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    : DEFAULT_ALLOWED_ANCESTORS;
  // De-dupe while preserving order.
  return Array.from(new Set(list));
}

/** True only when running in a browser inside a frame with a different top. */
export function isEmbedded(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent makes `window.top` access throw — which itself
    // means we are embedded cross-origin.
    return true;
  }
}

/** Whether `origin` is one of the allowlisted launcher origins. */
export function isAllowedAncestor(origin: string): boolean {
  return getAllowedAncestorOrigins().includes(origin);
}

/**
 * The single neutral `source` tag stamped on every message in both directions.
 * The launcher is generic across all brains, so it standardises on one
 * brand-agnostic tag rather than a per-brain one (a brand-specific tag would
 * be dropped). Both sides post with it and filter inbound on it.
 */
export const PORTAL_MESSAGE_SOURCE = 'brain-portal' as const;

/** Messages this brain sends up to the launcher. */
export type BrainMessage =
  | { source: typeof PORTAL_MESSAGE_SOURCE; type: 'ready' }
  | { source: typeof PORTAL_MESSAGE_SOURCE; type: 'auth-expired' }
  | { source: typeof PORTAL_MESSAGE_SOURCE; type: 'signed-out' };

/** Messages the launcher sends down to this brain. */
export type LauncherMessage =
  | { source: typeof PORTAL_MESSAGE_SOURCE; type: 'logout' }
  | { source: typeof PORTAL_MESSAGE_SOURCE; type: 'navigate'; path: string };

/**
 * Send a message to the parent launcher window. No-op when not embedded.
 * The message is posted once per allowlisted ancestor origin with an explicit
 * `targetOrigin` — never `'*'` — so a token/state message can never leak to an
 * unexpected parent. The browser silently drops the post to any origin that
 * isn't actually the current parent.
 */
export function postToLauncher(message: Omit<BrainMessage, 'source'>): void {
  if (typeof window === 'undefined' || !isEmbedded()) return;
  const parent = window.parent;
  if (!parent) return;
  const payload: BrainMessage = { source: PORTAL_MESSAGE_SOURCE, ...message } as BrainMessage;
  for (const origin of getAllowedAncestorOrigins()) {
    try {
      parent.postMessage(payload, origin);
    } catch {
      // Ignore per-origin post failures; other origins may still succeed.
    }
  }
}

/**
 * Type guard for an inbound `message` event's data: a well-formed launcher
 * message. Callers must still validate `event.origin` with `isAllowedAncestor`.
 */
export function isLauncherMessage(data: unknown): data is LauncherMessage {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.source === PORTAL_MESSAGE_SOURCE && typeof d.type === 'string';
}
