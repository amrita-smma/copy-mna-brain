import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { CopilotMessageRepository } from '@/lib/repositories';
import { BedrockEmbeddingClient } from '@/lib/bedrock';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { logger } from '../../logger';

/** Each hit's text is cut to this many characters in the tool output. */
const SNIPPET_CHARS = 700;

const argsSchema = z.object({
  query: z.string().min(1).describe('What to look for: a topic, company, person, number or phrase.'),
  scope: z
    .enum(['this_bot', 'all_bots'])
    .optional()
    .describe("'this_bot' (default) searches your own thread with the user; 'all_bots' searches the user's threads with every bot."),
  since: z.string().optional().describe('Only exchanges on or after this ISO date (e.g. 2026-09-01).'),
  until: z.string().optional().describe('Only exchanges on or before this ISO date.'),
  limit: z.number().int().min(1).max(20).optional().describe('How many exchanges to return (default 8).'),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Search the user's past conversations with their bots — the exchanges stored
 * in `copilot_messages`, which outlive the thread's summarized context. Hybrid:
 * meaning (embeddings) plus exact words (full text). Always scoped to the
 * signed-in user; when embeddings are unavailable it searches full text only.
 */
export const searchChatHistory = tool(
  async (args: Args, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: search_chat_history(query='${args.query}', scope=${args.scope ?? 'this_bot'})`);
    const ctx = readBotToolContext(config);
    if (!ctx) return NO_USER_CONTEXT_ERROR;

    try {
      let embedding: number[] | null = null;
      try {
        embedding = await new BedrockEmbeddingClient().embed(args.query);
      } catch (err) {
        logger.warn(`search_chat_history: embedding failed, using full text only: ${(err as Error).message}`);
      }
      const repo = new CopilotMessageRepository(createDb(), await getActiveWorkspaceId());
      const hits = await repo.hybridSearch({
        userId: ctx.userId,
        botId: (args.scope ?? 'this_bot') === 'this_bot' ? (ctx.botId ?? undefined) : undefined,
        query: args.query,
        embedding,
        limit: args.limit ?? 8,
        since: args.since,
        until: args.until,
      });
      if (hits.length === 0) return `No earlier conversation matches "${args.query}".`;

      const lines = hits.map((h) => {
        const date = h.created_at.slice(0, 10);
        const who = h.bot_name ? ` · ${h.bot_name}` : '';
        const text = h.text.length > SNIPPET_CHARS ? `${h.text.slice(0, SNIPPET_CHARS)}…` : h.text;
        return `### ${date}${who}\n${text}`;
      });
      return `**${hits.length} earlier exchange(s) matching "${args.query}"** (most relevant first):\n\n${lines.join('\n\n')}`;
    } catch (error) {
      logger.error(`search_chat_history error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'search_chat_history',
    description: `Search the user's earlier conversations with you (and, with scope 'all_bots', with their other bots). Your thread is permanent but older turns are summarized out of your context, so call this whenever the user refers back to something discussed before ("what did we say about X", "the number you gave me last month", "remind me what Deal Scout found") instead of guessing. Returns dated exchanges, most relevant first. Quote what was said and give its date.`,
    schema: argsSchema,
  },
);
