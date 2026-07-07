import { AsyncLocalStorage } from 'node:async_hooks';
import { MNA_WORKSPACE_ID, NO_ACTIVE_WORKSPACE_ID } from '@/lib/constants';

/**
 * Carries a workspace_id across an async call chain that has no HTTP request
 * to read a session from — specifically, an AI Workforce run's LangGraph
 * execution (`src/lib/workforce/runAgent.ts`). Verified by direct test that
 * this survives through LangChain's `tool()` wrapper and a real async DB-call
 * hop inside a tool handler, not just a bare promise chain.
 *
 * Do not use this for request-handling code — sessions already carry
 * workspace_id correctly there. This exists solely for the gap between "has
 * an active workspace" and "has no HTTP request at all," which agent tools
 * hit when running as part of an async workforce run instead of a live chat.
 */
const workforceWorkspaceContext = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `workspaceId` visible to every `getActiveWorkspaceId()` call
 * made anywhere in its async call chain (including inside agent tools).
 * Call this around the LangGraph `invoke`/`resume` call in an AI Workforce
 * run, seeded from the claimed queue row's own `workspace_id` — never from
 * `getActiveWorkspaceId()` itself, which has no session to read there.
 */
export function runWithWorkforceWorkspaceId<T>(workspaceId: string, fn: () => T): T {
  return workforceWorkspaceContext.run(workspaceId, fn);
}

/**
 * Resolves the active workspace for the current request/agent run.
 *
 * This is the single seam every call site threads through rather than
 * reading a constant directly. Four distinct cases matter here and must not
 * be conflated:
 *
 *  - An AI Workforce run executing via `runWithWorkforceWorkspaceId` — no
 *    HTTP request exists, but the run's own workspace_id is known and must
 *    win over everything below. Checked first since it's the most specific
 *    context available.
 *  - A request carrying an `X-Workspace-Id`/`X-Workspace-Slug` header (a
 *    tab's own `/w/<slug>/...` URL, propagated by `apiRequest`'s
 *    `buildWorkspaceHeaders` for client calls or by `proxy.ts` for page/RSC
 *    requests) — validated against the session's own membership list
 *    (`session.user.workspaces`, zero DB calls) and, on a match, wins over
 *    the session's globally-active `workspaceId`. This is what makes two
 *    tabs on two different workspaces independently correct instead of
 *    racing over one shared cookie.
 *  - No request context at all (job handlers, cron-triggered routines, the
 *    workforce dispatcher's queue-claim side) — `auth()` throws because
 *    there's no session to read. This is the ONLY case that falls back to
 *    `MNA_WORKSPACE_ID`, unchanged from this seam's original stub behavior.
 *  - A real request with a logged-in user who has no active workspace
 *    (unassigned new user, or a superadmin with no membership), or a header
 *    present but not found in the user's membership list (a spoofed header,
 *    or a stale/revoked membership) — both must fail closed
 *    (`NO_ACTIVE_WORKSPACE_ID`, which matches no real workspace row) rather
 *    than silently serve another tenant's data.
 *
 * The dynamic import of `@/auth` is load-bearing, not stylistic: a static
 * import here would close a real cycle (`auth.ts` -> `container.ts` ->
 * ... -> `workspace.ts`) and would pull this node-only module into the edge
 * bundle.
 */
export async function getActiveWorkspaceId(): Promise<string> {
  const workforceWorkspaceId = workforceWorkspaceContext.getStore();
  if (workforceWorkspaceId) {
    return workforceWorkspaceId;
  }
  try {
    const { auth } = await import('@/auth');
    const session = await auth();
    if (session?.user) {
      const { headers } = await import('next/headers');
      const requestHeaders = await headers();
      const headerWorkspaceId = requestHeaders.get('X-Workspace-Id');
      const headerSlug = requestHeaders.get('X-Workspace-Slug');

      if (headerWorkspaceId || headerSlug) {
        const workspaces = session.user.workspaces ?? [];
        // X-Workspace-Id is preferred when both are present — it's already a
        // UUID, no slug resolution ambiguity. In practice only one header is
        // ever set today (`buildWorkspaceHeaders` only sets the slug); the id
        // variant is reserved for future server-to-server callers that
        // already hold the UUID.
        const matched = headerWorkspaceId
          ? workspaces.find((w) => w.workspaceId === headerWorkspaceId)
          : workspaces.find((w) => w.slug === headerSlug);
        return matched ? matched.workspaceId : NO_ACTIVE_WORKSPACE_ID;
      }

      return session.user.workspaceId ?? NO_ACTIVE_WORKSPACE_ID;
    }
  } catch {
    // No request scope — fall through to the legacy constant below.
  }
  return MNA_WORKSPACE_ID;
}

/** Raised by `getActiveWorkspaceIdOrThrow` — see that function's doc comment. */
export class NoActiveWorkspaceError extends Error {
  constructor() {
    super('No active workspace for this request');
    this.name = 'NoActiveWorkspaceError';
  }
}

/**
 * Same resolution as `getActiveWorkspaceId()`, but throws instead of
 * returning the `NO_ACTIVE_WORKSPACE_ID` sentinel on a fail-closed case.
 *
 * Use this at write endpoints. A *read* scoped to `NO_ACTIVE_WORKSPACE_ID`
 * fails closed correctly on its own — no row has that id, so the query
 * naturally returns an empty result. A *write* has no equivalent safety net:
 * nothing stops the sentinel from being stamped onto an inserted row as if
 * it were a real workspace id, relying on incidental DB constraints (e.g. a
 * NOT NULL foreign key) rather than an intentional check to catch it.
 */
export async function getActiveWorkspaceIdOrThrow(): Promise<string> {
  const workspaceId = await getActiveWorkspaceId();
  if (workspaceId === NO_ACTIVE_WORKSPACE_ID) {
    throw new NoActiveWorkspaceError();
  }
  return workspaceId;
}
