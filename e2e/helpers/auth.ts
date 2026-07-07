import type { Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { getTestCredentials } from './credentials';

// UUID-shaped so routes not intercepted by a mock-mode spec's page.route()
// calls (e.g. ChatProvider's /api/copilot/chats) still get a well-formed id
// to query with — Postgres throws a type-cast error on a plain string, which
// previously never mattered because those unintercepted calls got a 401
// (no real session) instead of reaching the DB at all.
export const MOCK_USER: MockSessionUser = {
  id: '00000000-0000-0000-0000-0000000000e2',
  name: 'Test User',
  email: 'test@example.com',
  workspaceId: '00000000-0000-0000-0000-0000000000e2',
  isSuperadmin: false,
  workspaces: [{ workspaceId: '00000000-0000-0000-0000-0000000000e2', slug: 'mock-workspace' }],
};

export type MockSessionUser = {
  id: string;
  name: string;
  email: string;
  /** Active workspace claim — see `getActiveWorkspaceId`. Defaults to a
   *  single mock membership so workspace-scoped routes (`/w/[workspaceSlug]/...`
   *  and the legacy flat-path redirect bridge) resolve without hitting the DB. */
  workspaceId?: string | null;
  isSuperadmin?: boolean;
  workspaces?: { workspaceId: string; slug: string }[];
};

const SESSION_COOKIE_NAME = 'authjs.session-token';

/**
 * Forges a real, decryptable NextAuth session cookie (JWE, same format
 * `next-auth`'s own sign-in issues — see `@auth/core/jwt`'s `encode()`) and
 * sets it on the browser context, rather than only stubbing the client-side
 * `/api/auth/session` fetch as this helper did previously.
 *
 * That client-only stub stopped being sufficient once workspace-scoped
 * routes moved under `/w/[workspaceSlug]/...` (MB-337): the membership gate
 * in `src/app/w/[workspaceSlug]/layout.tsx`, the legacy flat-path redirect
 * bridge (`src/lib/legacyWorkspaceRedirect.ts`), and `src/proxy.ts` all call
 * the real server-side `auth()`, which reads the actual session cookie, not
 * the mocked fetch response. A real cookie satisfies both the client
 * `useSession()` call (now served by the real `/api/auth/session` handler,
 * decoding this cookie) and every server-side check in one shot — and keeps
 * them from ever disagreeing.
 *
 * Requires `AUTH_SECRET` in `.env.local` to match what the server under test
 * uses to decrypt cookies — true for the local docker/dev stack this suite
 * targets, per `playwright.config.ts`'s `TEST_ENV=local` default. Not
 * expected to work against staging/production (different, CI-only secrets),
 * which is also true of every other assumption `mockAuthSession`-based specs
 * make (mocked API routes replacing real data).
 *
 * Returns a `setUser` function so a single call site can flip between
 * unauthenticated and authenticated state mid-test (e.g. before vs. after a
 * successful sign-in).
 */
export const mockAuthSession = async (
  page: Page,
  initialUser: MockSessionUser | null = MOCK_USER,
) => {
  const setUser = async (user: MockSessionUser | null): Promise<void> => {
    const context = page.context();
    if (!user) {
      await context.clearCookies({ name: SESSION_COOKIE_NAME });
      return;
    }
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      throw new Error(
        'AUTH_SECRET must be set (see .env.local) for mockAuthSession() to forge a ' +
          'valid session cookie — workspace-scoped routes now require a real ' +
          'server-side session, not just a mocked /api/auth/session response.',
      );
    }
    const token = await encode({
      token: {
        id: user.id,
        name: user.name,
        email: user.email,
        workspaceId: user.workspaceId ?? null,
        isSuperadmin: user.isSuperadmin ?? false,
        workspaces: user.workspaces ?? [],
      },
      secret,
      salt: SESSION_COOKIE_NAME,
      maxAge: 30 * 24 * 60 * 60,
    });
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: token,
        url: process.env.LOCAL_BASE_URL ?? 'http://localhost:3000',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  };

  await setUser(initialUser);
  return { setUser };
};

/**
 * Perform a *real* credentials sign-in against the target environment — no
 * NextAuth mocking. Reads the env-specific test user from `getTestCredentials`
 * (LOCAL_/STAGING_/PRODUCTION_TEST_EMAIL+PASSWORD, picked by `TEST_ENV`),
 * submits the login form, and waits for the post-login redirect to the chat
 * page. This sets the real session cookie, so subsequent data fetches
 * (e.g. `/api/companies`) hit the real API and return real data.
 */
export const signIn = async (page: Page) => {
  const { email, password } = getTestCredentials();
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-email').fill(email);
  await page.locator('#signin-password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/chat');
};

/**
 * Stub the NextAuth credentials sign-in flow used by `signIn('credentials', …)`:
 *   1. GET  /api/auth/csrf                 → returns a fake csrf token
 *   2. POST /api/auth/callback/credentials → returns `{ url }` whose query
 *      string carries the error (or the success redirect target).
 *
 * Pass `errorCode` to simulate a failed login. `next-auth` surfaces the value
 * from `?error=` as the `error` field in the resolved object, which our
 * `useAuth.signIn` then wraps as `new Error(errorCode)`.
 */
export const mockNextAuthSignIn = async (
  page: Page,
  opts: { errorCode?: string; redirectUrl?: string; delayMs?: number } = {},
) => {
  await page.route(/\/api\/auth\/csrf/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ csrfToken: 'test-csrf-token' }),
    }),
  );

  // next-auth v5's `signIn()` fetches `/api/auth/providers` before the actual
  // credentials POST. Without this, the dev server's UntrustedHost check
  // short-circuits the flow and the page bounces to /api/auth/error.
  await page.route(/\/api\/auth\/providers/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        credentials: {
          id: 'credentials',
          name: 'Credentials',
          type: 'credentials',
          signinUrl: 'http://localhost:3000/api/auth/signin/credentials',
          callbackUrl: 'http://localhost:3000/api/auth/callback/credentials',
        },
      }),
    }),
  );

  await page.route(/\/api\/auth\/callback\/credentials/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    const url = opts.errorCode
      ? `http://localhost:3000/login?error=${opts.errorCode}`
      : opts.redirectUrl ?? 'http://localhost:3000/chat';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url }),
    });
  });
};
