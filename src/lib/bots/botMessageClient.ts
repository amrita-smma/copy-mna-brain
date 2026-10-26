/**
 * How one bot messages another: a POST to our own
 * `/api/internal/bot-messages`, which inserts the `jobs` row and starts the
 * Workflow run. The caller — the chat route's `after()`, the dispatch cron, a
 * running turn's step — only sends the message; the hand-off is a logged
 * request in its own invocation.
 *
 * No retry: a repeated send after a timeout could run a turn twice. The
 * caller logs the failure (and a routine reverts its schedule advance).
 */
import type { BotMessageJob } from '@/lib/services/botService';
import { internalApiHeaders, internalApiUrl } from '@/lib/server/internalApi';

export const BOT_MESSAGES_PATH = '/api/internal/bot-messages';
/**
 * Longer than the route's own deadline on starting the run
 * (`START_RUN_TIMEOUT_MS`, 15 s) plus its failure bookkeeping, so a slow start
 * comes back as the route's 504 with a reason, not as this abort.
 */
export const SEND_BOT_MESSAGE_TIMEOUT_MS = 30_000;

export async function sendBotMessage(input: {
  workspaceId: string;
  job: BotMessageJob;
}): Promise<{ jobId: string; runId: string }> {
  const { workspaceId, job } = input;
  const url = internalApiUrl(BOT_MESSAGES_PATH);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: internalApiHeaders(),
      body: JSON.stringify({ workspaceId, ...job }),
      cache: 'no-store',
      signal: AbortSignal.timeout(SEND_BOT_MESSAGE_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`bot message to ${job.toBotId} could not reach ${url}: ${message}`, { cause: err });
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!res.ok) {
    const serverError = typeof record?.error === 'string' ? record.error : null;
    const why =
      serverError ??
      (res.status === 401 || res.status === 403
        ? 'the deployment refused the call (Deployment Protection without a bypass secret, or an ADMIN_SECRET mismatch)'
        : text.slice(0, 200) || res.statusText);
    throw new Error(`bot message to ${job.toBotId} rejected by ${url} (${res.status}): ${why}`);
  }
  const data = record?.data as { jobId?: unknown; runId?: unknown } | undefined;
  if (typeof data?.jobId !== 'string' || typeof data?.runId !== 'string') {
    throw new Error(`bot message to ${job.toBotId}: unexpected response from ${url}: ${text.slice(0, 200)}`);
  }
  return { jobId: data.jobId, runId: data.runId };
}
