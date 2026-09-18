import NextAuth from "next-auth";
import { MNA_WORKSPACE_ID } from "@/lib/constants";
import Credentials from "next-auth/providers/credentials";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { authConfig } from "@/auth.config";
import { captureUserEvent } from "@/lib/posthog-server";
import type { WorkspaceService } from "@/lib/services/workspaceService";

/**
 * Shape embedded in the JWT so edge middleware (`src/proxy.ts`) and the
 * `getActiveWorkspaceId()` seam can validate a URL/header-supplied workspace
 * slug against real membership without a DB round-trip. Deliberately just
 * `{workspaceId, slug}` — no name/role, since nothing downstream needs more
 * than "is this workspace in the list."
 */
async function getWorkspaceClaims(
  workspaceService: WorkspaceService,
  userId: string,
) {
  const accessible =
    await workspaceService.getAccessibleWorkspacesForUser(userId);
  return accessible.map((m) => ({
    workspaceId: m.workspaceId,
    slug: m.workspaceSlug,
  }));
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
      if (trigger === "update") {
        const db = createDb();
        const { workspaceService, consentService } = createContainer(
          db,
          MNA_WORKSPACE_ID,
        );

        if (typeof session?.workspaceId === "string") {
          const isMember = await workspaceService.isMember(
            token.id as string,
            session.workspaceId,
          );
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
        token.workspaces = await getWorkspaceClaims(
          workspaceService,
          token.id as string,
        );

        // Re-read consent from the DB rather than trusting the client-supplied
        // `session.hasConsented` value — the same "never trust the client's
        // claim, re-derive from source of truth" rule the membership check
        // above follows. The consent page's `update({ hasConsented: true })`
        // call right after its POST succeeds exists purely to force this
        // refresh — the payload's VALUE is ignored here on purpose; its mere
        // presence is what makes next-auth's client POST instead of GET.
        token.hasConsented = await consentService.hasConsented(token.id as string);
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
          const { authService, workspaceService, consentService } = createContainer(
            db,
            MNA_WORKSPACE_ID,
          );
          const user = await authService.signIn(email, password);
          const [workspaceId, isSuperadmin, workspaces, hasConsented] = await Promise.all([
            workspaceService.resolveDefaultWorkspaceId(user.id),
            workspaceService.isSuperadmin(user.id),
            getWorkspaceClaims(workspaceService, user.id),
            consentService.hasConsented(user.id),
          ]);
          return {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name,
            workspaceId,
            isSuperadmin,
            workspaces,
            hasConsented,
          };
        } catch (err) {
          // Auth.js collapses any null/throw in authorize() into the opaque
          // `CredentialsSignin` code. Log the real cause so prod failures
          // (DB unreachable, TLS handshake, bad hash shape, wrong password)
          // are distinguishable in the server logs.
          console.error("[auth] authorize failed:", err);
          return null;
        }
      },
    }),
    Credentials({
      // Google SSO: login-page "Sign in with Google" button. Kept for the
      // standalone login flow; the launcher deeplink uses launcher-sso below.
      id: "google-sso",
      name: "Google SSO",
      credentials: {
        token: {},
      },
      async authorize(credentials) {
        const token = credentials?.token as string | undefined;
        if (!token) return null;
        try {
          const db = createDb();
          const { authService, workspaceService, consentService } = createContainer(
            db,
            MNA_WORKSPACE_ID,
          );
          const user = await authService.signInWithGoogleToken(token);
          const [workspaceId, isSuperadmin, workspaces, hasConsented] = await Promise.all([
            workspaceService.resolveDefaultWorkspaceId(user.id),
            workspaceService.isSuperadmin(user.id),
            getWorkspaceClaims(workspaceService, user.id),
            consentService.hasConsented(user.id),
          ]);
          return {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name,
            workspaceId,
            isSuperadmin,
            workspaces,
            hasConsented,
          };
        } catch (err) {
          console.error("[auth] google-sso authorize failed:", err);
          return null;
        }
      },
    }),
    Credentials({
      // Launcher SSO: the Brain Launcher embeds this app in an iframe and
      // hands over the signed-in user's identity as an RS256-signed JWT via
      // `?from=launcher&token=<JWT>` on the URL. `proxy.ts` intercepts any
      // `?token=` and routes it to `/api/auth/sso`, which calls this provider.
      // After a successful verify + user lookup the session is identical to a
      // password sign-in — the rest of the auth flow is unchanged.
      id: "launcher-sso",
      name: "Launcher SSO",
      credentials: {
        token: {},
      },
      async authorize(credentials) {
        const token = credentials?.token as string | undefined;
        if (!token) return null;
        try {
          const db = createDb();
          const { authService, workspaceService, consentService } = createContainer(
            db,
            MNA_WORKSPACE_ID,
          );
          const user = await authService.signInWithLauncherToken(token);
          const [workspaceId, isSuperadmin, workspaces, hasConsented] = await Promise.all([
            workspaceService.resolveDefaultWorkspaceId(user.id),
            workspaceService.isSuperadmin(user.id),
            getWorkspaceClaims(workspaceService, user.id),
            consentService.hasConsented(user.id),
          ]);
          return {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name,
            workspaceId,
            isSuperadmin,
            workspaces,
            hasConsented,
          };
        } catch (err) {
          console.error("[auth] launcher-sso authorize failed:", err);
          return null;
        }
      },
    }),
  ],
  events: {
    /**
     * `user_signed_in`, captured server-side.
     *
     * This used to be a `posthog.capture()` on the login page, which never
     * arrived: `before_send` drops everything captured on `/login` (see
     * `@/lib/posthog-events`). Emitting it here fixes that and makes the event
     * immune to ad blockers, which is the whole point of moving the events that
     * matter for per-user attribution off the client.
     *
     * No workspace yet at sign-in time — the user hasn't picked one — so this
     * is a `captureUserEvent`, not a `captureWorkspaceEvent`.
     */
    async signIn({ user, account }) {
      if (!user.id) return;
      captureUserEvent({
        distinctId: user.id,
        event: "user_signed_in",
        properties: {
          // Matches the distinct id `PostHogIdentityTracker` identifies with,
          // so the sign-in lands on the same person as the session's events.
          method: account?.provider ?? "unknown",
          email: user.email ?? undefined,
        },
      });
    },
  },
});

/** A workspace this user can access, as embedded in the JWT — see `getWorkspaceClaims`. */
export interface WorkspaceClaim {
  workspaceId: string;
  slug: string;
}

declare module "next-auth" {
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
      /** Has this user accepted the Sync/Terms consent screen? Gates `/w/*`
       *  in `proxy.ts` — see `ConsentService.hasConsented`. */
      hasConsented: boolean;
    };
  }
  interface User {
    id: string;
    workspaceId?: string | null;
    isSuperadmin?: boolean;
    workspaces?: WorkspaceClaim[];
    hasConsented?: boolean;
  }
}

// A real augmentation (not a cast-based free-for-all) now that `workspaces`
// is a structured array, not a scalar like `id`/`workspaceId`. The import
// (unused otherwise) is load-bearing: without it TS can't resolve this as an
// augmentation of the existing module rather than a failed ambient one.
import type {} from "next-auth/jwt";
declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    name?: string | null;
    email?: string | null;
    workspaceId: string | null;
    isSuperadmin: boolean;
    workspaces: WorkspaceClaim[];
    hasConsented: boolean;
  }
}
