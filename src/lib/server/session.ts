import { cache } from 'react';
import { auth } from '@/auth';

/**
 * Request-scoped `auth()`.
 *
 * Resolving a session decrypts the session JWE, and a single page render asks
 * for it several times over — the workspace layout gates on it, then each page
 * resolves it again (directly, or indirectly through `getActiveWorkspaceId`).
 * `cache` collapses those into one decrypt per request.
 *
 * Use this from server components and route handlers. Do NOT wrap the `auth`
 * export itself: `auth` doubles as the middleware wrapper in `src/proxy.ts`,
 * where it is called with a handler rather than as a zero-arg session read.
 *
 * Guarded the same way `@/lib/features/overrides` guards its own `cache` use —
 * `cache` is only defined in a React server runtime, so fall back to the bare
 * call elsewhere (e.g. vitest).
 */
export const getSession = typeof cache === 'function' ? cache(() => auth()) : () => auth();
