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
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.name = user.name;
        token.email = user.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.name = (token.name as string) ?? session.user.name;
        session.user.email = (token.email as string) ?? session.user.email;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
