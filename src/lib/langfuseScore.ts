import { Langfuse } from 'langfuse';
import { isLangfuseEnabled, langfuseEnvironment } from '@/lib/langfuseClient';

export interface LangfuseScoreInput {
  /** Langfuse upserts a score on its id, so a re-sent score replaces the old one. */
  id: string;
  traceId: string;
  name: string;
  value: number;
  comment?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Attach a numeric score to a trace. Best-effort and gated like tracing itself
 * (`isLangfuseEnabled`): a down or unconfigured Langfuse is logged, never
 * thrown, and callers run this after the response (`after()`) so the request
 * never waits on it. Sent with its own client and drained before returning,
 * like `createPptxTrace` — the shared LangChain handler only flushes at the
 * end of a turn.
 */
export async function sendLangfuseScore(score: LangfuseScoreInput): Promise<void> {
  if (!isLangfuseEnabled()) return;
  try {
    const langfuse = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || 'http://langfuse-web:3000',
      environment: langfuseEnvironment(),
      release: process.env.VERCEL_GIT_COMMIT_SHA,
    });
    langfuse.score({
      id: score.id,
      traceId: score.traceId,
      name: score.name,
      value: score.value,
      dataType: 'NUMERIC',
      comment: score.comment ?? undefined,
      metadata: score.metadata,
    });
    await langfuse.shutdownAsync();
  } catch (err) {
    console.warn('[langfuse] score failed', err);
  }
}
