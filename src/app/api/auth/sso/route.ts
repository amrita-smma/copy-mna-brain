import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/auth";
import { MNA_WORKSPACE_ID } from "@/lib/constants";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { isWorkspaceScopedPath, resolveSsoLandingPath } from "@/lib/ssoLanding";

/**
 * Server-side launcher SSO deeplink handler.
 *
 * `proxy.ts` routes any URL carrying a `?token=` here exactly once, so the
 * whole `?token` flow is a few synchronous server steps with no client-side
 * orchestration:
 *   1. Validate the launcher-signed RS256 JWT (inside the `launcher-sso`
 *      provider's `authorize()`, which calls `verifyLauncherToken`).
 *   2. Resolve the matching local user by verified email.
 *   3. On a match, establish the NextAuth session (Set-Cookie) — i.e. treat it
 *      as valid credentials.
 *   4. Redirect the browser to the intended URL with the `token` stripped —
 *      or to the `/workspace` picker when the user can enter more than one
 *      workspace and the URL didn't name one (see `resolveSsoLandingPath`).
 *
 * If verification fails or the email is not registered, the user is sent to
 * the login page — the launcher handles re-auth by reloading the frame `src`
 * with a fresh token, so we never hard-fail inside the frame.
 */

/** Same-origin absolute paths only — never an open redirect to another host. */
function safeCallback(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

/**
 * Redirect via a RELATIVE `Location`. The browser resolves it against its own
 * origin, which is correct in every environment — including local `vercel dev`,
 * where the request the route handler sees carries the internal proxy port
 * (not the browser's :3001), so an absolute URL built from `req.url` would send
 * the browser to the wrong port. Cookies set by `signIn` via `next/headers` are
 * still attached to this response by the Next runtime.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { Location: path } });
}

/**
 * Landing path for a session that was just established from `token`.
 *
 * The membership list is re-resolved from the token rather than read back off
 * the session: the cookie `signIn` just set is not visible to `auth()` within
 * this same request (it reads the *incoming* headers). `signIn` has already
 * verified this token and matched the user, so this is a repeat lookup, not a
 * second trust decision — and any failure falls back to `callbackUrl` rather
 * than stranding a user whose session is already valid.
 */
async function resolveLandingPath(
  token: string,
  callbackUrl: string,
): Promise<string> {
  // Skip the lookup entirely when the destination already names a workspace.
  if (isWorkspaceScopedPath(callbackUrl)) return callbackUrl;

  try {
    const db = createDb();
    // Workspace-agnostic services — MNA_WORKSPACE_ID is just a container-
    // construction arg here, not a tenant decision (same as `src/auth.ts`).
    const { authService, workspaceService } = createContainer(
      db,
      MNA_WORKSPACE_ID,
    );
    const user = await authService.signInWithLauncherToken(token);
    const workspaces = await workspaceService.getAccessibleWorkspacesForUser(
      user.id,
    );
    return resolveSsoLandingPath({
      callbackUrl,
      workspaceCount: workspaces.length,
    });
  } catch (err) {
    console.error("[auth] launcher SSO landing resolution failed:", err);
    return callbackUrl;
  }
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const callbackUrl = safeCallback(req.nextUrl.searchParams.get("callbackUrl"));

  if (!token) return redirectTo("/login?error=launcher-sso");

  try {
    // `redirect: false` → establish the session (Set-Cookie via next/headers)
    // and RETURN the resolved URL instead of throwing an absolute redirect.
    // A failed authorize() (invalid token / no matching user) either throws or
    // yields a URL carrying `?error=` — both funnel to the login error below.
    const resultUrl = await signIn("launcher-sso", { token, redirect: false });
    const failed = typeof resultUrl === "string" && /[?&]error=/.test(resultUrl);
    if (failed) return redirectTo("/login?error=launcher-sso");
    return redirectTo(await resolveLandingPath(token, callbackUrl));
  } catch (err) {
    console.error("[auth] launcher SSO token login failed:", err);
    return redirectTo("/login?error=launcher-sso");
  }
}
