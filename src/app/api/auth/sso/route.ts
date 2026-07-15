import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/auth";

/**
 * Server-side Google-SSO deeplink handler.
 *
 * `proxy.ts` routes any URL carrying a `?token=` here exactly once, so the
 * whole `?token` flow is a few synchronous server steps with no client-side
 * orchestration:
 *   1. Validate the Google ID token (inside the `google-sso` provider's
 *      `authorize()`, which calls `verifyGoogleIdToken`).
 *   2. Resolve the matching local user by verified email.
 *   3. On a match, establish the NextAuth session (Set-Cookie) — i.e. treat it
 *      as valid credentials.
 *   4. Redirect the browser to the intended URL with the `token` stripped.
 *
 * This replaces the old client-side `GoogleSsoTokenGate`, whose in-render
 * session mutation + soft `router.replace` overlapped with the app's other
 * redirects (`/` → `/chat` → `/w/<slug>/chat`, `ProtectedRoute`) and crashed
 * the App Router with "Rendered more hooks than during the previous render".
 * Consuming the token before any page renders removes that whole class of race.
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

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const callbackUrl = safeCallback(req.nextUrl.searchParams.get("callbackUrl"));

  if (!token) return redirectTo("/login?error=google-sso");

  try {
    // `redirect: false` → establish the session (Set-Cookie via next/headers)
    // and RETURN the resolved URL instead of throwing an absolute redirect.
    // A failed authorize() (invalid token / no matching user) either throws or
    // yields a URL carrying `?error=` — both funnel to the login error below.
    const resultUrl = await signIn("google-sso", { token, redirect: false });
    const failed = typeof resultUrl === "string" && /[?&]error=/.test(resultUrl);
    return redirectTo(failed ? "/login?error=google-sso" : callbackUrl);
  } catch (err) {
    console.error("[auth] SSO token login failed:", err);
    return redirectTo("/login?error=google-sso");
  }
}
