/**
 * Where a launcher SSO deeplink (`?token=<JWT>`) lands once the session has
 * been established by `/api/auth/sso`.
 *
 * The session's active workspace is seeded by
 * `workspaceService.resolveDefaultWorkspaceId()`, which necessarily picks ONE
 * workspace (the platform workspace, else the oldest membership). For a user
 * who belongs to several, that pick is a guess — so instead of dropping them
 * into whichever workspace happened to sort first, send them to the picker at
 * `/workspace` and let them choose. Users with a single accessible workspace
 * have nothing to choose, so they keep going straight to their destination
 * (and `/workspace` would only bounce them right back anyway).
 */

/** Whether `path` is a workspace-scoped app path (`/w/<slug>/...`). */
export function isWorkspaceScopedPath(path: string): boolean {
  return /^\/w\/[^/?#]+(?:[/?#]|$)/.test(path);
}

export interface SsoLandingInput {
  /** Same-origin absolute path the deeplink asked for (already sanitized). */
  callbackUrl: string;
  /** How many workspaces the signed-in user can enter — memberships plus, for
   *  a superadmin, every other workspace (see
   *  `getAccessibleWorkspacesForUser`). */
  workspaceCount: number;
}

export function resolveSsoLandingPath({ callbackUrl, workspaceCount }: SsoLandingInput): string {
  // A `/w/<slug>/...` deeplink already names the workspace it wants, so there
  // is nothing to disambiguate. `proxy.ts` still validates that slug against
  // real membership and bounces to `/workspace` itself if it doesn't check out.
  if (isWorkspaceScopedPath(callbackUrl)) return callbackUrl;

  return workspaceCount > 1 ? '/workspace' : callbackUrl;
}
