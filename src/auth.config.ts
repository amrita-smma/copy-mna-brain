import type { NextAuthConfig } from 'next-auth';

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
