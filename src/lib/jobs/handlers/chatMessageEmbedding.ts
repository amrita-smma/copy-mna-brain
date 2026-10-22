import { CopilotMessageRepository, type DbClient } from '@/lib/repositories';
import { BedrockEmbeddingClient } from '@/lib/bedrock';

/** A thread's one-time history import can queue every exchange it holds. */
export const CHAT_MESSAGE_EMBEDDING_TIMEOUT_SECONDS = 300;

interface Embedder {
  embed(text: string): Promise<number[]>;
}

/**
 * Embed stored chat exchanges (assistant rows of `copilot_messages`) so
 * `search_chat_history` can find them by meaning. One failed row is logged and
 * skipped: it stays findable through full-text search.
 */
export async function runChatMessageEmbedding(deps: {
  db: DbClient;
  workspaceId: string;
  messageIds: string[];
  embedder?: Embedder;
}): Promise<{ embedded: number; skipped: number }> {
  const repo = new CopilotMessageRepository(deps.db, deps.workspaceId);
  const embedder = deps.embedder ?? new BedrockEmbeddingClient();
  let embedded = 0;
  let skipped = 0;
  for (const id of deps.messageIds) {
    const row = await repo.findById(id);
    if (!row || !row.text.trim()) {
      skipped++;
      continue;
    }
    try {
      await repo.setEmbedding(id, await embedder.embed(row.text));
      embedded++;
    } catch (err) {
      console.error(`[chat-history] failed to embed message ${id}:`, err);
      skipped++;
    }
  }
  return { embedded, skipped };
}
