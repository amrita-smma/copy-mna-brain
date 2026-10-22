import { createContainer } from '@/lib/services/container';
import { UserRepository, type DbClient } from '@/lib/repositories';
import { getAgentGraph } from '@/lib/agents/analysis/graphs';
import { isCopilotAgentType } from '@/lib/agents/analysis/flavors/keys';
import { copilotMemoryEnabled, sourceOfFundsEnabled } from '@/lib/flags';
import { runWithWorkforceWorkspaceId } from '@/lib/workspace';
import { runWithLangfuseUser } from '@/lib/langfuseUser';
import { flushLangfuse } from '@/lib/langfuse';
import { runBotTurn } from '@/lib/bots/runBotTurn';
import type { BotMessageJob } from '@/lib/services/botService';

/** The answering turn plus up to a minute waiting for the thread's lock. */
export const BOT_MESSAGE_TIMEOUT_SECONDS = 600;

/**
 * The `bot_message` / `bot_routine` job: a bot answers a message handed to it
 * — an @mention, or its routine firing — in the user's own thread with it.
 * Runs with no session, so the workspace and the user are set explicitly for
 * the tools (the workspace context store, `configurable.userId`) and for
 * tracing.
 *
 * A routine speaks for the user, so the bots its reply @mentions are pinged
 * in turn; a reply to a mention pings nobody (chains are one hop deep).
 */
export async function runBotMessage(
  deps: { db: DbClient; workspaceId: string } & BotMessageJob,
): Promise<{ chatId: string }> {
  const { db, workspaceId, userId } = deps;
  return runWithWorkforceWorkspaceId(workspaceId, () =>
    runWithLangfuseUser(userId, async () => {
      const {
        botService,
        botRequestService,
        botTaskLogService,
        chatService,
        copilotChatsService,
        chatHistoryService,
        userMemoryService,
        botMemoryService,
      } = createContainer(db, workspaceId);
      const { bot, chat } = await botService.openThread(userId, deps.toBotId);
      const user = await new UserRepository(db).findById(userId);
      const [sof, memoryAllowed] = await Promise.all([sourceOfFundsEnabled(), copilotMemoryEnabled()]);
      // The request behind this message (a bot_mention) is closed whatever
      // happens, so the asker hears back: the answer, or why there is none.
      const closeRequest = async (outcome: { answer: string } | { failure: string }) => {
        if (!deps.requestId) return;
        await botRequestService
          .close(deps.requestId, outcome)
          .catch((err: unknown) => console.error('[bot-message] failed to close the request:', err));
      };
      try {
        let result;
        try {
          result = await runBotTurn(
          {
            workspaceId,
            bot,
            chat,
            user: { id: userId, email: user?.email ?? null, name: user?.name ?? null },
            origin: deps.origin,
            text: deps.text,
            // Only routine turns may @mention other bots (one hop). Replies to
            // mentions must not be told they can delegate — nothing would run.
            extraContext:
              deps.origin.kind === 'routine' ? await botService.mentionContext(userId, bot.id) : '',
          },
          {
            getGraph: (flavor) =>
              getAgentGraph(isCopilotAgentType(flavor) ? flavor : 'mna', 'medium', Boolean(sof)),
            buildContext: () => chatService.buildContext(),
            claimTurn: (id, ttl) => copilotChatsService.claimTurn(id, ttl),
            releaseTurn: (id) => copilotChatsService.releaseTurn(id),
            persistTurn: (input) => chatHistoryService.persistTurn(input),
            persistQuestion: (input) => chatHistoryService.persistQuestion(input),
            discardQuestion: (id) => chatHistoryService.discardQuestion(id),
            // A background turn answers the user too (an @mention, a routine,
            // another bot's reply), so it reads the same memory the chat does.
            ...(memoryAllowed ? { recallMemory: (text) => userMemoryService(userId).recallForTurn(text) } : {}),
            // The notes this user keeps on this bot: not gated by the mem0
            // switch, they are explicit requests, not inferred memory.
            botMemoryContext: () => botMemoryService.promptContext(userId, bot.id),
          },
          );
        } catch (err) {
          await closeRequest({ failure: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        await closeRequest({ answer: result.answerText || '(no answer)' });
        await botTaskLogService
          .record({
            botId: bot.id,
            userId,
            chatId: chat.id,
            source: deps.origin.kind === 'routine' ? 'routine' : 'mention',
            routine: deps.origin.kind === 'routine' ? deps.origin.routine : null,
            question: result.userText,
            answer: result.answerText,
            toolNames: result.toolNames,
          })
          .catch((err: unknown) => console.error('[bot-message] failed to queue the task log entry:', err));
        if (deps.origin.kind === 'routine') {
          await botService
            .dispatchMentions(userId, {
              bot: { id: bot.id, name: bot.name },
              replyText: result.answerText,
              chatId: chat.id,
              turnId: result.turnId,
            })
            .catch((err: unknown) => console.error('[bot-message] failed to hand on @mentions:', err));
        }
      } finally {
        await flushLangfuse();
      }
      return { chatId: chat.id };
    }),
  );
}
