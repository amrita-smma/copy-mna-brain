/**
 * The app calling itself over HTTP. One bot hands a message to another through
 * `POST /api/internal/bot-messages` rather than by starting the work in-process,
 * so every hand-off is a logged request in its own invocation — the audit
 * trail — and the caller carries none of the work.
 *
 * Three things a self-call needs, all from the env:
 *   - the deployment's own URL (`internalApiUrl`): on Vercel the production
 *     domain, or the deployment URL for a preview; locally `APP_URL` and
 *     friends, else localhost (inside the docker `app` container that is the
 *     app itself). `INTERNAL_API_URL` overrides everything.
 *   - the shared secret (`ADMIN_SECRET` as `X-Api-Secret`): the repo's
 *     machine-to-machine credential, the one the data pipeline uses to call
 *     the smart-files route. `src/proxy.ts` gates `/api/internal/` on it and
 *     the handler checks it again.
 *   - the Deployment Protection bypass for a protected (preview) URL:
 *     `VERCEL_AUTOMATION_BYPASS_SECRET`, which Vercel exposes once "Protection
 *     Bypass for Automation" is enabled on the project.
 */

type Env = Record<string, string | undefined>;

const stripSlash = (url: string) => url.replace(/\/+$/, '');

export function internalApiBaseUrl(env: Env = process.env): string {
  const explicit = env.INTERNAL_API_URL?.trim();
  if (explicit) return stripSlash(explicit);
  if (env.VERCEL) {
    if (env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL) {
      return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  }
  const local = env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? env.NEXTAUTH_URL ?? 'http://localhost:3000';
  return stripSlash(local.trim());
}

/** Absolute URL of one of our own routes, `path` starting with `/`. */
export function internalApiUrl(path: string, env: Env = process.env): string {
  return `${internalApiBaseUrl(env)}${path}`;
}

/** Headers for a self-call: JSON, the shared secret, the protection bypass. */
export function internalApiHeaders(env: Env = process.env): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.ADMIN_SECRET) headers['x-api-secret'] = env.ADMIN_SECRET;
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers['x-vercel-protection-bypass'] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  return headers;
}

export type InternalAuth = 'ok' | 'unauthorized' | 'missing-secret';

/**
 * What an internal route does with a request's `X-Api-Secret` header: it must
 * equal `ADMIN_SECRET`. Always fails closed — without the secret configured
 * nothing gets in, as in `src/proxy.ts`.
 */
export function checkInternalSecret(apiSecret: string | null, env: Env = process.env): InternalAuth {
  const secret = env.ADMIN_SECRET;
  if (!secret) return 'missing-secret';
  return apiSecret === secret ? 'ok' : 'unauthorized';
}
