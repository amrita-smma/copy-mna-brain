/**
 * What happens once a chat turn's response has finished — the body of the
 * `after()` hook `POST /api/chat` registers as soon as the thread's lock is
 * held, so it runs on every path, including an error further down the route.
 *
 * Under the lock: the turn is stored in the chat history (`copilot_messages`
 * — what the UI pages and the bots search), then the lock is released. Off
 * the lock, in this order: the reply's @mentions are handed on, the turn is
 * queued for the bot's task log, the mem0 memory is updated, and the thread
 * is summarized ahead of need if it has grown past the mark.
 *
 * Everything reads the persisted turn rather than the request body, so it
 * sees the answer that was actually given (including a budget wrap-up), and
 * never runs for an aborted turn that persisted nothing.
 *
 * The lock is released as soon as the thread is stored, NOT after the whole
 * hook: the @mention hand-off, the task-log entry, the memory write-back (an
 * LLM call) and the summary do not need it, and holding the lock through them
 * made a quick follow-up message 409 for seconds.
 *
 * Memory (mem0) is gated on the same flag as recall, so it is all-or-nothing.
 * Deliberately NOT a job row: a one-shot, best-effort side effect with
 * nothing to retry; a failure is logged and the turn stands. The history
 * write queues its own embedding job.
 *
 * Every database access is on a background connection (`withBackgroundDb`):
 * the request's pooled one may already be gone once the response has been
 * sent.
 */
import type { BaseMessage } from '@langchain/core/messages';
import { extractLastTurn } from '@/lib/agents/analysis';
import { lastHumanMessageId } from '@/lib/agents/analysis/messages';
import type { AgentGraph, ThreadSnapshot } from '@/lib/agents/analysis/runtime';
import { withBackgroundDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import type { CopilotChatRow } from '@/lib/repositories/copilotChatsRepository';
import { publishReply, type TurnPresence } from '@/lib/bots/presence';
import { summarizeThreadAhead } from '@/lib/bots/summarizeAhead';
import { turnToolNames } from '@/lib/bots/runBotTurn';
import type { EffortChoice } from './effortTiers';

export interface FinishTurnInput {
  agent: Pick<AgentGraph, 'getThreadSnapshot' | 'replaceMessagesIfAt'>;
  workspaceId: string;
  userId: string;
  bot: { id: string; name: string };
  chat: Pick<CopilotChatRow, 'id' | 'user_id' | 'bot_id' | 'history_imported_at'>;
  turnId: string;
  /**
   * The question row the route stored at the start of the turn — its id, the
   * model and tier the reply was produced with, and whether the insert
   * landed. Null when the turn carried no message to store.
   */
  question: {
    id: string;
    turn: { model: string; effortTier: EffortChoice };
    written: boolean;
  } | null;
  /**
   * The thread's last user message before this turn. Still the last one
   * afterwards means the turn never reached the thread (it failed before the
   * agent ran): nothing is stored, and the question comes back out.
   */
  priorLastHumanId: string | null;
  /** The bots the user's own @mentions already pinged; not pinged again. */
  userPinged: readonly string[];
  /** The mem0 kill-switch, read at the start of the turn. */
  memoryAllowed: boolean;
  /** The turn's live presence; cleared right after the lock is released. */
  presence: TurnPresence | undefined;
}

interface StoredTurn {
  finished: ThreadSnapshot;
  finalMessages: BaseMessage[];
}

/**
 * Store the turn and release the lock. Null when there was nothing to store:
 * the thread could not be read, or the turn never reached it.
 */
async function storeTurn(input: FinishTurnInput): Promise<StoredTurn | null> {
  const { agent, workspaceId, userId, bot, chat, turnId, question } = input;
  try {
    let finished: ThreadSnapshot;
    try {
      finished = await agent.getThreadSnapshot(chat.id);
    } catch (err) {
      console.error('[chat] failed to read the finished turn:', err);
      return null;
    }
    const finalMessages = finished.messages;
    if (lastHumanMessageId(finalMessages) === input.priorLastHumanId) {
      if (question?.written) {
        await withBackgroundDb(async (bgDb) =>
          createContainer(bgDb, workspaceId).chatHistoryService.discardQuestion(question.id),
        ).catch((err: unknown) => {
          console.error('[chat] failed to discard the unanswered question:', err);
        });
      }
      return null;
    }
    try {
      await withBackgroundDb(async (bgDb) => {
        const { chatHistoryService: bgHistory } = createContainer(bgDb, workspaceId);
        await bgHistory.persistTurn({
          chat,
          finalMessages,
          interactive: true,
          questionStored: question?.written ?? false,
          // What the up-front write stamped, for the case it had failed: the
          // question is stored here under the same id, so the id the reply
          // was given never dangles.
          ...(question ? { question: { id: question.id, turn: question.turn } } : {}),
        });
      });
      // Stored: other tabs reload the thread (this one streamed it live).
      await publishReply(workspaceId, userId, { chatId: chat.id, botId: bot.id, turnId });
    } catch (err) {
      console.error('[chat] failed to store the turn in history:', err);
    }
    return { finished, finalMessages };
  } finally {
    await withBackgroundDb(async (bgDb) =>
      createContainer(bgDb, workspaceId).copilotChatsService.releaseTurn(chat.id),
    ).catch((err: unknown) => {
      console.error('[chat] failed to release the turn lock:', err);
    });
    // After the lock: a client must never see the bot idle while the thread
    // still refuses its next message.
    await input.presence?.done();
  }
}

/** Record what the stored turn established. Nothing here writes to the thread. */
async function recordTurn(input: FinishTurnInput, stored: StoredTurn): Promise<void> {
  const { agent, workspaceId, userId, bot, chat, turnId } = input;
  const { finished, finalMessages } = stored;
  // Hand the reply's @mentions on (the user's went out when the message
  // arrived). Each answers in the background in its own chat with the user.
  const { userText, assistantText } = extractLastTurn(finalMessages);
  try {
    await withBackgroundDb(async (bgDb) => {
      const { botService: bgBots } = createContainer(bgDb, workspaceId);
      await bgBots.dispatchMentions(userId, {
        bot: { id: bot.id, name: bot.name },
        replyText: assistantText,
        alreadyPinged: input.userPinged,
        chatId: chat.id,
        turnId,
      });
    });
  } catch (err) {
    console.error('[chat] failed to hand on @mentions:', err);
  }
  // Queue the turn for the bot's task log (summarized in a job).
  try {
    await withBackgroundDb(async (bgDb) => {
      const { botTaskLogService: bgTasks } = createContainer(bgDb, workspaceId);
      await bgTasks.record({
        botId: bot.id,
        userId,
        chatId: chat.id,
        source: 'chat',
        routine: null,
        question: userText,
        answer: assistantText,
        toolNames: turnToolNames(finalMessages),
      });
    });
  } catch (err) {
    console.error('[chat] failed to queue the task log entry:', err);
  }
  if (input.memoryAllowed && assistantText.trim()) {
    try {
      await withBackgroundDb(async (bgDb) => {
        const { userMemoryService: bgMemoryService } = createContainer(bgDb, workspaceId);
        await bgMemoryService(userId).rememberTurn({
          userId,
          chatId: chat.id,
          userText,
          assistantText,
        });
      });
    } catch (err) {
      console.error('[chat] failed to record the turn to memory:', err);
    }
  }
  // Last, being the slowest: once the thread passes the ahead mark, its
  // older turns are summarized now, from the read above and off the lock,
  // rather than in line before the next turn's first model call
  // (`summarizeThreadAhead`). Best-effort: the in-line trigger remains.
  try {
    await withBackgroundDb(async (bgDb) => {
      const { copilotChatsService: bgChats } = createContainer(bgDb, workspaceId);
      await summarizeThreadAhead({
        agent,
        chatId: chat.id,
        known: finished,
        claimTurn: (id, ttl) => bgChats.claimTurn(id, ttl),
        releaseTurn: (id) => bgChats.releaseTurn(id),
      });
    });
  } catch (err) {
    console.error('[chat] failed to summarize the thread ahead of need:', err);
  }
}

/** Store the turn, release the lock, then record what it established. */
export async function finishTurn(input: FinishTurnInput): Promise<void> {
  const stored = await storeTurn(input);
  if (!stored) return;
  await recordTurn(input, stored);
}
