import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;
        try {
          const db = createDb();
          const { authService } = createContainer(db);
          const user = await authService.signIn(email, password);
          return {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name,
          };
        } catch (err) {
          // Auth.js collapses any null/throw in authorize() into the opaque
          // `CredentialsSignin` code. Log the real cause so prod failures
          // (DB unreachable, TLS handshake, bad hash shape, wrong password)
          // are distinguishable in the server logs.
          console.error('[auth] authorize failed:', err);
          return null;
        }
      },
    }),
    Credentials({
      // Google SSO: the dashboard is reachable via `?token=<google id token>`.
      // We validate that token against Google, resolve the local user by the
      // verified email, and from here the JWT session is identical to a
      // password sign-in — the rest of the auth flow is unchanged.
      id: 'google-sso',
      name: 'Google SSO',
      credentials: {
        token: {},
      },
      async authorize(credentials) {
        const token = credentials?.token as string | undefined;
        if (!token) return null;
        try {
          const db = createDb();
          const { authService } = createContainer(db);
          const user = await authService.signInWithGoogleToken(token);
          return {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name,
          };
        } catch (err) {
          console.error('[auth] google-sso authorize failed:', err);
          return null;
        }
      },
    }),
  ],
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
});

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
  interface User {
    id: string;
  }
}

