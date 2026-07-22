import type { NextAuthConfig } from 'next-auth';
import { IFRAME_EMBED_ENABLED } from '@/lib/iframe';

// When this app is embedded in the launcher iframe, its auth cookies are set
// from inside a cross-site frame. Browsers refuse to store/send such cookies
// unless they are `SameSite=None; Secure` and, to survive third-party-cookie
// partitioning (CHIPS), `Partitioned`. We keep Auth.js's secure cookie *names*
// (`__Secure-`/`__Host-` prefixes) so `stripStaleCookiesIfNeeded` in
// `src/proxy.ts` still matches them. When embedding is disabled this is
// omitted entirely and Auth.js keeps its safe `SameSite=Lax` defaults.
const crossSiteCookieOptions = {
  sameSite: 'none',
  path: '/',
  secure: true,
  partitioned: true,
} as const;

const iframeCookies: NextAuthConfig['cookies'] = IFRAME_EMBED_ENABLED
  ? {
      sessionToken: {
        name: '__Secure-authjs.session-token',
        options: { httpOnly: true, ...crossSiteCookieOptions },
      },
      callbackUrl: {
        name: '__Secure-authjs.callback-url',
        options: { httpOnly: true, ...crossSiteCookieOptions },
      },
      csrfToken: {
        name: '__Host-authjs.csrf-token',
        options: { httpOnly: true, ...crossSiteCookieOptions },
      },
    }
  : undefined;

/**
 * Edge-safe NextAuth configuration shared between the full auth instance
 * (`src/auth.ts`, which adds the Credentials providers and touches the DB)
 * and the middleware instance (`src/proxy.ts`, which only needs to read and
 * verify the JWT session cookie).
 *
 * This module MUST NOT import anything Node-only (no DB client, no services) —
 * it is bundled into the edge middleware. Providers that hit the database are
 * added in `src/auth.ts` only; they run on the Node `/api/auth/[...nextauth]`
 * route during sign-in, never in middleware.
 */
export const authConfig = {
  // maxAge bounds how stale `token.workspaces` (the JWT-embedded membership
  // list every workspace-scoped check validates against, zero DB calls) can
  // get: it's only refreshed from the DB on sign-in or an explicit
  // `update()` call, never passively. A superadmin removing a member's
  // workspace access doesn't take effect for that member until their token
  // is reissued — shortened from the 30-day default to 12h to bound that
  // window, not to give a rolling/sliding session. NextAuth's default
  // `updateAge` (24h) is longer than this maxAge, so a session hard-expires
  // (forcing full re-login, which does refresh `workspaces` from the DB)
  // rather than silently rolling forward on activity.
  session: { strategy: 'jwt', maxAge: 60 * 60 * 12 },
  pages: { signIn: '/login' },
  // Only set when iframe embedding is enabled — see `iframeCookies` above.
  ...(iframeCookies ? { cookies: iframeCookies } : {}),
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.name = user.name;
        token.email = user.email;
        token.workspaceId = user.workspaceId ?? null;
        token.isSuperadmin = user.isSuperadmin ?? false;
        token.workspaces = user.workspaces ?? [];
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.name = (token.name as string) ?? session.user.name;
        session.user.email = (token.email as string) ?? session.user.email;
        session.user.workspaceId = (token.workspaceId as string | null) ?? null;
        session.user.isSuperadmin = Boolean(token.isSuperadmin);
        session.user.workspaces = token.workspaces ?? [];
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
