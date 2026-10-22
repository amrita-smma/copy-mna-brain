/**
 * One background turn of a bot, run with nobody watching: the bot answers a
 * message that reached it through an @mention (typed by the user, or written
 * by another bot in its reply), one its routine sent on the user's behalf, or
 * the answers of bots it handed work to. Runs inside the `bot_message` /
 * `bot_routine` / `bot_reply` job, with no request and no session, so
 * everything a chat turn gets from the request — the workspace, the user, the
 * turn lock — is passed in explicitly.
 *
 * The reply lands in the user's own thread with the bot and is stored unread,
 * so the bot strip shows a dot until the user opens it. While it runs, the
 * bot's live presence (`./presence`) shows it thinking, and Stop on the thread
 * aborts it.
 */
import { randomUUID } from 'node:crypto';
import { HumanMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentGraph } from '@/lib/agents/analysis/runtime';
import type { BotRow, CopilotChatRow } from '@/lib/repositories';
import { FROM_BOT_KWARG, FROM_ROUTINE_KWARG, type FromBot } from '@/lib/chat/uiMessages';
import { extractLastTurn, lastHumanMessageId } from '@/lib/agents/analysis/messages';
import { buildBotTurnOverride } from './threadMiddleware';
import {
  PresenceCallbackHandler,
  publishReply,
  startTurnPresence,
  watchStop,
  type StopWatch,
  type TurnPresence,
  type TurnPresenceInput,
} from './presence';

/** Tools a background turn never gets: no browser, nobody to approve a
 *  send or a new routine or to pick from an option card, and nobody watching
 *  a routine be deleted (a routine may still pause itself with update_routine). */
export const BACKGROUND_WITHHELD_TOOLS = [
  'send_email',
  'navigate_page',
  'read_page_context',
  'propose_create_routine',
  'delete_routine',
  'offer_options',
] as const;

/** One bot's answer to a request this bot made (see `bot_requests`). */
export interface BotReplyEntry {
  fromBot: { id: string; name: string };
  requestId: string;
  /** What this bot asked, clipped. */
  ask: string;
  /** The answer, or null when the other bot failed. */
  answer: string | null;
  /** Why there is no answer, when there is none. */
  failure: string | null;
}

/** How a background turn's message reached the bot. */
export type BotTurnOrigin =
  /** Another bot @mentioned this one in its reply to the user. */
  | { kind: 'bot_mention'; fromBot: { id: string; name: string } }
  /** The user @mentioned this bot while chatting with another one. */
  | { kind: 'user_mention'; inBot: { id: string; name: string } }
  /** The bot's routine fired, on behalf of the routine's creator. */
  | { kind: 'routine'; routine: { id: string; title: string } }
  /** The bots this one handed work to (by @mention) have all answered. */
  | { kind: 'bot_reply'; replies: BotReplyEntry[] };

/** How long to wait for an interactive turn on the same thread to finish. */
export const TURN_LOCK_WAIT_MS = 60_000;
export const TURN_LOCK_POLL_MS = 3_000;
/** The lock's own expiry, in case this run dies holding it. */
export const TURN_LOCK_TTL_SECONDS = 600;

export class BotThreadBusyError extends Error {
  constructor(botName: string) {
    super(`${botName}'s chat stayed busy; the message was not answered`);
    this.name = 'BotThreadBusyError';
  }
}

export interface BotTurnInput {
  workspaceId: string;
  bot: BotRow;
  chat: CopilotChatRow;
  user: { id: string; email: string | null; name: string | null };
  origin: BotTurnOrigin;
  text: string;
  /** Per-turn notes added to the workspace context (e.g. the bots it can @mention). */
  extraContext?: string;
  /** Identifies this turn in presence and reply events; generated when absent. */
  turnId?: string;
}

export interface BotTurnResult {
  /** The user message and the bot's final answer, as plain text. */
  userText: string;
  answerText: string;
  /** Names of the tools the bot called this turn. */
  toolNames: string[];
  turnId: string;
}

export interface BotTurnDeps {
  getGraph(flavor: string): Promise<AgentGraph | null>;
  /** The workspace context a chat turn carries (`ChatService.buildContext`). */
  buildContext(): Promise<string>;
  claimTurn(chatId: string, ttlSeconds: number): Promise<boolean>;
  releaseTurn(chatId: string): Promise<void>;
  persistTurn(input: {
    chat: CopilotChatRow;
    finalMessages: BaseMessage[];
    interactive: boolean;
    authorBotId: string | null;
    /** The question row went in when the turn started; store the reply only. */
    questionStored: boolean;
  }): Promise<void>;
  /**
   * Store the question as the turn starts (`ChatHistoryService.persistQuestion`),
   * so the target's thread shows it, under the thinking bubble, while the bot
   * works. Optional: without it the whole turn is stored at the end.
   */
  persistQuestion?(input: {
    chat: CopilotChatRow;
    message: BaseMessage;
    prior: BaseMessage[];
    authorBotId: string | null;
  }): Promise<string | null>;
  /** Drop that question row when the turn never reached the thread. */
  discardQuestion?(id: string): Promise<void>;
  /**
   * What the bot remembers about the user, for this message
   * (`UserMemoryService.recallForTurn`): the same block an interactive turn
   * gets. Optional and best-effort — null, a failure or a slow lookup means
   * the turn runs without memory.
   */
  recallMemory?(text: string): Promise<string | null>;
  /**
   * The notes this user asked this bot to keep (`BotMemoryService.promptContext`),
   * the same block an interactive turn gets. Optional and best-effort.
   */
  botMemoryContext?(): Promise<string | null>;
  sleep?(ms: number): Promise<void>;
  /** The live-state hooks (`./presence`); injectable so tests need no Redis. */
  startPresence?(input: TurnPresenceInput): TurnPresence;
  watchStop?(chatId: string): StopWatch;
  publishReply?(workspaceId: string, userId: string, reply: { chatId: string; botId: string; turnId: string }): Promise<void>;
}

/** One line per answer, for the bot_reply context. */
function describeReplies(replies: BotReplyEntry[]): string {
  return replies
    .map((r) => {
      const outcome = r.answer !== null ? r.answer : `could not complete it: ${r.failure ?? 'no answer'}`;
      return `- ${r.fromBot.name} (you asked: «${r.ask}»): ${outcome}`;
    })
    .join('\n');
}

/** The note that tells the bot how this turn's message reached it. */
export function originContext(origin: BotTurnOrigin): string {
  switch (origin.kind) {
    case 'bot_mention': {
      const sender = origin.fromBot.name;
      return `This turn's message is a reply ${sender}, another of the user's Copilot bots, wrote to the user; it @mentioned you to hand you a task. The user did not type it. Do what it asks of you and answer for the user, who will read your reply later in this chat. Your answer is also passed back to ${sender}, which folds it into its own reply to the user — so answer the task fully and in your own words; do not @mention ${sender}.`;
    }
    case 'user_mention':
      return `The user wrote this message in their chat with ${origin.inBot.name} and @mentioned you in it, so it was passed to you as well. Answer the part meant for you; the user will read your reply later in this chat. ${origin.inBot.name} answers separately.`;
    case 'routine':
      return `This turn's message was sent automatically by the routine "${origin.routine.title}", which the user scheduled; the user did not type it just now and is not watching. Do the task and answer for the user, who will read your reply later in this chat.`;
    case 'bot_reply': {
      const names = [...new Set(origin.replies.map((r) => r.fromBot.name))];
      const who = names.length === 1 ? `${names[0]} has` : `${names.join(', ')} have`;
      return `This turn's message is not from the user: ${who} answered the work you handed on by @mention earlier in this chat. The answers:\n\n${describeReplies(origin.replies)}\n\nWrite the answer for the user from these, in your own words, crediting each bot for its part; say plainly when one could not complete its task. The user did not type this and is not watching; they will read your reply later in this chat. Do not @mention any bot about this again.`;
    }
  }
}

/** The kwargs that label the message in the transcript; never sent to the model. */
function originKwargs(origin: BotTurnOrigin): Record<string, unknown> {
  switch (origin.kind) {
    case 'bot_mention':
      return { [FROM_BOT_KWARG]: { ...origin.fromBot } satisfies FromBot };
    case 'user_mention':
      return { [FROM_BOT_KWARG]: { ...origin.inBot, kind: 'user_mention' } satisfies FromBot };
    case 'routine':
      return { [FROM_ROUTINE_KWARG]: { ...origin.routine } };
    case 'bot_reply':
      return { [FROM_BOT_KWARG]: { ...origin.replies[0].fromBot, kind: 'bot_reply' } satisfies FromBot };
  }
}

/** The bot whose words a turn's user message carries, for the history row. */
function authorBotId(origin: BotTurnOrigin): string | null {
  switch (origin.kind) {
    case 'bot_mention':
      return origin.fromBot.id;
    case 'bot_reply':
      return origin.replies[0].fromBot.id;
    default:
      return null;
  }
}

/** The tools the bot called in the turn that just finished. */
export function turnToolNames(finalMessages: BaseMessage[]): string[] {
  let lastHuman = -1;
  finalMessages.forEach((m, i) => {
    if (m.getType() === 'human') lastHuman = i;
  });
  const names = finalMessages
    .slice(lastHuman + 1)
    .flatMap((m) => (m.getType() === 'ai' ? ((m as AIMessage).tool_calls ?? []).map((c) => c.name) : []));
  return [...new Set(names)];
}

export async function runBotTurn(input: BotTurnInput, deps: BotTurnDeps): Promise<BotTurnResult> {
  const { workspaceId, bot, chat, user, origin, text } = input;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const turnId = input.turnId ?? randomUUID();

  // Wait out an interactive turn on the same thread rather than interleave
  // two writers on one checkpoint thread.
  let claimed = await deps.claimTurn(chat.id, TURN_LOCK_TTL_SECONDS);
  for (let waited = 0; !claimed && waited < TURN_LOCK_WAIT_MS; waited += TURN_LOCK_POLL_MS) {
    await sleep(TURN_LOCK_POLL_MS);
    claimed = await deps.claimTurn(chat.id, TURN_LOCK_TTL_SECONDS);
  }
  if (!claimed) throw new BotThreadBusyError(bot.name);

  // Live state, from the moment the lock is ours: the bot shows as thinking
  // in every open tab, and Stop on the thread aborts the run.
  const presence = (deps.startPresence ?? startTurnPresence)({
    workspaceId,
    userId: user.id,
    chatId: chat.id,
    botId: bot.id,
    turnId,
  });
  const stop = (deps.watchStop ?? watchStop)(chat.id);

  try {
    const agent = await deps.getGraph(bot.base_flavor);
    if (!agent) throw new Error('Agent not available (check ANTHROPIC_API_KEY and the checkpointer)');

    // Read before the run: a turn that never reached the thread (aborted or
    // failed before the input was checkpointed) must not store the previous
    // turn again. Same guard as the chat route.
    const prior = await agent.getMessages(chat.id);
    const priorLastHumanId = lastHumanMessageId(prior);

    const question = new HumanMessage({
      content: text,
      additional_kwargs: originKwargs(origin),
    });
    // The question is in the history before the agent runs: the target's
    // chat shows who asked what, under the thinking bubble, from the first
    // second. Best-effort — without it the turn stores both at the end.
    let questionRowId: string | null = null;
    if (deps.persistQuestion) {
      try {
        questionRowId = await deps.persistQuestion({ chat, message: question, prior, authorBotId: authorBotId(origin) });
      } catch (err) {
        console.error('[bots] failed to store the question in history:', err);
      }
    }

    // A turn that never reached the thread (failed or was stopped before the
    // agent checkpointed its input) would leave its stored question sitting
    // there unanswered, so take it back out. Same guard as the chat route.
    const discardIfUnreached = async () => {
      if (!questionRowId || !deps.discardQuestion) return;
      const now = await agent.getMessages(chat.id).catch(() => null);
      if (now && lastHumanMessageId(now) !== priorLastHumanId) return;
      await deps.discardQuestion(questionRowId).catch((err: unknown) => {
        console.error('[bots] failed to discard the unanswered question:', err);
      });
    };

    const [context, memoryContext, botMemoryContext] = await Promise.all([
      deps.buildContext(),
      deps.recallMemory
        ? deps.recallMemory(text).catch((err: unknown) => {
            console.error('[bots] memory recall failed; the turn runs without memory:', err);
            return null;
          })
        : Promise.resolve(null),
      deps.botMemoryContext
        ? deps.botMemoryContext().catch((err: unknown) => {
            console.error('[bots] bot memory lookup failed; the turn runs without it:', err);
            return null;
          })
        : Promise.resolve(null),
    ]);
    let finalMessages: BaseMessage[];
    try {
      await agent.invoke(
      {
        messages: [question],
        additionalSystemContext: [context, memoryContext, botMemoryContext, input.extraContext, originContext(origin)]
          .filter(Boolean)
          .join('\n\n'),
        withheldTools: [...BACKGROUND_WITHHELD_TOOLS],
        override: buildBotTurnOverride(agent, bot),
      },
      {
        recursionLimit: 50,
        configurable: {
          thread_id: chat.id,
          userId: user.id,
          botId: bot.id,
          userEmail: user.email,
          userName: user.name,
          agentRole: 'chat',
          originalUserQuestion: text,
          agent_key: 'general',
        },
        signal: stop.signal,
        callbacks: [new PresenceCallbackHandler(presence.setPhase)],
      },
      );
      finalMessages = await agent.getMessages(chat.id);
    } catch (err) {
      await discardIfUnreached();
      throw err;
    }

    if (lastHumanMessageId(finalMessages) === priorLastHumanId) {
      await discardIfUnreached();
      return { userText: text, answerText: '', toolNames: [], turnId };
    }
    await deps.persistTurn({
      chat,
      finalMessages,
      interactive: false,
      authorBotId: authorBotId(origin),
      questionStored: questionRowId !== null,
    });
    await (deps.publishReply ?? publishReply)(workspaceId, user.id, { chatId: chat.id, botId: bot.id, turnId });
    const { userText, assistantText } = extractLastTurn(finalMessages);
    return { userText, answerText: assistantText, toolNames: turnToolNames(finalMessages), turnId };
  } finally {
    // The lock first, then the live marker: a client must never see the bot
    // idle while the thread is still locked against its next message.
    await deps.releaseTurn(chat.id);
    await presence.done();
    stop.dispose();
  }
}
