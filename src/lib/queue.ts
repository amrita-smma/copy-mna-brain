import type { SendEmailPayload } from '@/lib/jobs/handlers/sendEmail';

/**
 * Centralized topic names. The string here must match
 *   1. the `topic` field in the consumer route's `vercel.json` trigger, and
 *   2. the route path (`src/app/api/queues/<topic>/route.ts`) by convention.
 *
 * Vercel's topic name pattern is `[A-Za-z0-9_-]+`, so we use kebab-case.
 */
export const TOPICS = {
  sendEmail: 'send-email',
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

/**
 * Lazily import `@vercel/queue` so that consumers of this module — including
 * the unit-tested `AuthService` — don't pay the cost of pulling in the SDK
 * on import. Tests can also vi.mock('@/lib/queue') without needing to mock
 * the upstream package.
 */
async function vercelSend<T>(topic: TopicName, payload: T): Promise<{ messageId: string | null }> {
  const { send } = await import('../../launchpad/queue');
  return send<T>(topic, payload);
}

/**
 * Enqueue a transactional email for asynchronous delivery via Vercel Queues.
 *
 * The message is processed by the consumer route at
 * `src/app/api/queues/send-email/route.ts`, which is wired to the
 * `send-email` topic via `vercel.json`. The route is private — only Vercel's
 * queue infrastructure can invoke it.
 *
 * Returns the queue message id (or `null` when the server defers the id) for
 * logging / tracing. Throws on transport / auth errors — callers should let
 * those propagate so the originating HTTP request reflects the failure (or
 * choose to swallow them, e.g. forgot-password's anti-enumeration response).
 */
export async function enqueueSendEmail(payload: SendEmailPayload): Promise<{ messageId: string | null }> {
  return vercelSend(TOPICS.sendEmail, payload);
}
