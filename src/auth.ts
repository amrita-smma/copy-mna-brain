import NextAuth from 'next-auth';
import { MNA_WORKSPACE_ID } from '@/lib/constants';
import Credentials from 'next-auth/providers/credentials';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { authConfig } from '@/auth.config';
import type { WorkspaceService } from '@/lib/services/workspaceService';

/**
 * Shape embedded in the JWT so edge middleware (`src/proxy.ts`) and the
 * `getActiveWorkspaceId()` seam can validate a URL/header-supplied workspace
 * slug against real membership without a DB round-trip. Deliberately just
 * `{workspaceId, slug}` — no name/role, since nothing downstream needs more
 * than "is this workspace in the list."
 */
async function getWorkspaceClaims(workspaceService: WorkspaceService, userId: string) {
  const accessible = await workspaceService.getAccessibleWorkspacesForUser(userId);
  return accessible.map((m) => ({ workspaceId: m.workspaceId, slug: m.workspaceSlug }));
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, trigger, session }) {
      // Sign-in seeding (id/name/email/workspaceId/isSuperadmin) — same logic
      // the edge-safe config uses, so middleware and this full instance agree.
      //
      // Deliberately no backfill here for a token issued before workspaceId/
      // isSuperadmin/workspaces existed on the JWT (pre-dating this feature).
      // A backfill can only run in this Node-side callback (DB access), but
      // `proxy.ts`'s edge-safe middleware gates almost every request first
      // and would redirect such a user to `/workspace` before this callback
      // ever runs. That redirect is self-healing, not a dead end: `/workspace`
      // fetches real memberships live from the DB (bypassing the stale JWT
      // entirely), and picking one calls `update()`, hitting the
      // `trigger === 'update'` branch below — which repopulates `workspaces`
      // and fixes the token for every request after that one click.
      token = await authConfig.callbacks.jwt({ token, user });

      // Workspace switch: the client called `update({ workspaceId })`. This is
      // the ONLY place in the callback layer that touches the DB, and it only
      // runs on the node `/api/auth/session` update call — never in edge
      // middleware or a bare `getActiveWorkspaceId()` read.
      //
      // Membership is re-validated here BEFORE writing the new workspaceId
      // into the token — without this check a user could set an arbitrary
      // workspaceId via `update()` and read/write another tenant's data.
      if (trigger === 'update') {
        const db = createDb();
        const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);

        if (typeof session?.workspaceId === 'string') {
          const isMember = await workspaceService.isMember(token.id as string, session.workspaceId);
          if (isMember) {
            token.workspaceId = session.workspaceId;
          }
          // else: silently ignore the switch attempt, keep the current claim.
        }

        // Refresh the membership list on every update() call, not just
        // successful switches — this is the only callback-layer moment
        // (besides sign-in) that touches the DB, so it's also the only
        // chance to un-stale a returning user's `token.workspaces` short of
        // a full re-login.
        token.workspaces = await getWorkspaceClaims(workspaceService, token.id as string);
      }

      return token;
    },
  },
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
          // Workspace doesn't matter for authService/workspaceService (both
          // workspace-agnostic) — MNA_WORKSPACE_ID here is just a throwaway
          // container-construction arg, not a tenant decision.
          const { authService, workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
          const user = await authService.signIn(email, password);
          const [workspaceId, isSuperadmin, workspaces] = await Promise.all([
            workspaceService.resolveDefaultWorkspaceId(user.id),
            workspaceService.isSuperadmin(user.id),
            getWorkspaceClaims(workspaceService, user.id),
          ]);
          return {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name,
            workspaceId,
            isSuperadmin,
            workspaces,
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
          const { authService, workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
          const user = await authService.signInWithGoogleToken(token);
          const [workspaceId, isSuperadmin, workspaces] = await Promise.all([
            workspaceService.resolveDefaultWorkspaceId(user.id),
            workspaceService.isSuperadmin(user.id),
            getWorkspaceClaims(workspaceService, user.id),
          ]);
          return {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name,
            workspaceId,
            isSuperadmin,
            workspaces,
          };
        } catch (err) {
          console.error('[auth] google-sso authorize failed:', err);
          return null;
        }
      },
    }),
  ],
});

/** A workspace this user can access, as embedded in the JWT — see `getWorkspaceClaims`. */
export interface WorkspaceClaim {
  workspaceId: string;
  slug: string;
}

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      /** Active workspace for this session. Null means no active workspace
       *  (unassigned user, or a superadmin with no membership) — see
       *  `getActiveWorkspaceId`'s NO_ACTIVE_WORKSPACE_ID fail-closed handling. */
      workspaceId: string | null;
      /** Platform-wide flag, independent of any workspace membership. */
      isSuperadmin: boolean;
      /** Every workspace this user can enter — used to validate a URL/header
       *  supplied workspace (slug or id) without a DB round-trip. */
      workspaces: WorkspaceClaim[];
    };
  }
  interface User {
    id: string;
    workspaceId?: string | null;
    isSuperadmin?: boolean;
    workspaces?: WorkspaceClaim[];
  }
}

// A real augmentation (not a cast-based free-for-all) now that `workspaces`
// is a structured array, not a scalar like `id`/`workspaceId`. The import
// (unused otherwise) is load-bearing: without it TS can't resolve this as an
// augmentation of the existing module rather than a failed ambient one.
import type {} from 'next-auth/jwt';
declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    name?: string | null;
    email?: string | null;
    workspaceId: string | null;
    isSuperadmin: boolean;
    workspaces: WorkspaceClaim[];
  }
}

