import { handleCallback } from '@vercel/queue';
import {
  runSendEmail,
  SEND_EMAIL_TIMEOUT_SECONDS,
  type SendEmailPayload,
} from '@/lib/jobs/handlers/sendEmail';

/**
 * Consumer route for the `send-email` queue topic.
 *
 * Wired in `vercel.json`:
 *
 *   "src/app/api/queues/send-email/route.ts": {
 *     "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "send-email" }]
 *   }
 *
 * That trigger declaration makes the route private — it has no public URL on
 * Vercel and only the queue infrastructure can invoke it. Locally with
 * `next dev` the route is reachable, which is acceptable for development.
 *
 * Responsibilities here are intentionally thin: deserialize the payload,
 * delegate to the pure `runSendEmail` (still unit-tested in isolation), and
 * let any thrown error propagate so `handleCallback` retries with backoff.
 */
export const POST = handleCallback<SendEmailPayload>(
  async (message) => {
    await runSendEmail(message);
  },
  {
    visibilityTimeoutSeconds: SEND_EMAIL_TIMEOUT_SECONDS,
    retry: (_error, metadata) => {
      // Stop retrying after 5 deliveries — emails this stale are no longer
      // useful and we don't want a poison message stuck in the queue.
      if (metadata.deliveryCount > 5) return { acknowledge: true };
      // Exponential backoff capped at 5 minutes.
      const afterSeconds = Math.min(300, 2 ** metadata.deliveryCount * 5);
      return { afterSeconds };
    },
  },
);
