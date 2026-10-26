import type { BaseMessage } from '@langchain/core/messages';
import type {
  CopilotChatRow,
  CopilotChatsRepository,
  CopilotMessageRepository,
  CopilotMessageRow,
  CopilotResponseFeedbackRepository,
  NewCopilotMessage,
} from '@/lib/repositories';
import { toResponseFeedbackValue } from '@/lib/chat/responseFeedback';
import {
  lastTurnUIMessages,
  toUIMessages,
  type FromBot,
  type FromRoutine,
  type UIMessageOut,
  type UIPart,
} from '@/lib/chat/uiMessages';

/**
 * Turns per history page when the caller doesn't ask for a size: opening a
 * bot loads its last few turns, and older ones load as the user scrolls up.
 */
export const CHAT_HISTORY_PAGE_TURNS = 5;

/**
 * Stored-message part that carries a user message's inline image attachments
 * (the UI's `experimental_attachments`). Pulled back out when a page renders.
 */
const ATTACHMENTS_PART = 'data-attachments';
/** Stored-message part naming the bot that sent a user message (an @mention). */
const FROM_BOT_PART = 'data-from-bot';
/** Stored-message part naming the routine that sent a user message. */
const FROM_ROUTINE_PART = 'data-from-routine';

/**
 * Inline (data-URI) images bigger than this are not stored: the history row
 * would carry megabytes of base64 for a thumbnail the user already saw.
 */
const MAX_STORED_ATTACHMENT_CHARS = 1_000_000;

export interface ChatHistoryDeps {
  messages: CopilotMessageRepository;
  chats: CopilotChatsRepository;
  /** The user's feedback on replies, laid onto each page (MB-693). */
  feedback: CopilotResponseFeedbackRepository;
  /** Queue embedding of stored exchanges (assistant rows) for history search. */
  dispatchEmbedding: (messageIds: string[]) => Promise<unknown>;
}

export interface ChatHistoryPageOut {
  messages: UIMessageOut[];
  /** Pass as `before` for the previous page; null at the start of the thread. */
  nextCursor: number | null;
}

type StoredAttachments = { type: typeof ATTACHMENTS_PART; data: UIMessageOut['experimental_attachments'] };
type StoredFromBot = { type: typeof FROM_BOT_PART; data: FromBot };
type StoredFromRoutine = { type: typeof FROM_ROUTINE_PART; data: FromRoutine };
type StoredPart = UIPart | StoredAttachments | StoredFromBot | StoredFromRoutine;

function partText(parts: readonly UIPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * The chat's history as rows (`copilot_messages`): written after every turn,
 * paged for the UI, and searched by the bots. A thread that predates the table
 * has its checkpoint history imported once, on first read or first write,
 * whichever comes first.
 */
export class ChatHistoryService {
  constructor(private readonly deps: ChatHistoryDeps) {}

  /**
   * Store the question the moment its turn is claimed, so a tab reloaded
   * mid-turn shows it under the live bubble instead of an empty thread (the
   * reply follows in `persistTurn`, which then stores only the reply).
   * `message` is the human message the turn hands the agent; `prior` is the
   * thread's checkpoint before it, for a thread's one-time import. `turn`:
   * the model and effort tier the turn runs on, recorded on the row so
   * feedback on the reply can say what produced it. Returns the row's id, for
   * `persistTurn` and `discardQuestion` — and the id a reply's feedback is
   * keyed on.
   */
  async persistQuestion(input: {
    chat: Pick<CopilotChatRow, 'id' | 'user_id' | 'bot_id' | 'history_imported_at'>;
    message: BaseMessage;
    prior: BaseMessage[];
    authorBotId?: string | null;
    turn?: { model: string; effortTier: string };
  }): Promise<string | null> {
    const { chat } = input;
    // A thread from before the table: its earlier turns come in first, so the
    // question lands after them. (`persistTurn` then finds it imported.)
    if (!chat.history_imported_at) await this.importIfFirst(chat, () => Promise.resolve(input.prior));
    const ui = toUIMessages([input.message]).filter((m) => m.role === 'user');
    if (ui.length === 0) return null;
    const rows = this.toRows(chat, ui, input.authorBotId ?? null).map((r) =>
      input.turn ? { ...r, model: input.turn.model, effort_tier: input.turn.effortTier } : r,
    );
    const [row] = await this.deps.messages.insertMany(rows);
    return row?.id ?? null;
  }

  /** Drop a stored question whose turn never reached the thread (aborted or failed before the agent ran). */
  async discardQuestion(id: string): Promise<void> {
    await this.deps.messages.deleteById(id);
  }

  /**
   * Store the turn that just finished. `finalMessages` is the thread's
   * checkpoint after the turn. `interactive` is false for a background turn
   * (a message from another bot), which leaves the thread unread.
   * `questionStored`: `persistQuestion` already wrote the user row when the
   * turn started, so only the reply is stored here.
   */
  async persistTurn(input: {
    chat: Pick<CopilotChatRow, 'id' | 'user_id' | 'bot_id' | 'history_imported_at'>;
    finalMessages: BaseMessage[];
    interactive: boolean;
    authorBotId?: string | null;
    questionStored?: boolean;
  }): Promise<void> {
    const { chat, finalMessages } = input;
    // A thread's first write imports everything the checkpoint holds, which
    // already includes this turn. Skipped outright once the thread is imported,
    // which is every turn but its first (and `persistQuestion` imports before
    // its write, so a turn whose question is stored never gets here).
    const imported =
      !chat.history_imported_at &&
      (await this.importIfFirst(chat, () => Promise.resolve(finalMessages)));
    if (!imported) {
      const ui = lastTurnUIMessages(finalMessages);
      if (!ui.some((m) => m.role === 'assistant')) return;
      // The reply's row text still carries the question: `toRows` reads it
      // from the batch before the user row is dropped.
      const rows = this.toRows(chat, ui, input.authorBotId ?? null).filter(
        (r) => !(input.questionStored && r.role === 'user'),
      );
      const inserted = await this.deps.messages.insertMany(rows);
      await this.embed(inserted);
    }
    await this.deps.chats.stampMessage(chat.id, { read: input.interactive });
  }

  /**
   * One page of the thread, oldest first: its last `turns` turns before the
   * cursor, never splitting one. `loadCheckpoint` reads the thread's
   * checkpoint for the one-time import; the caller owns the agent graph.
   */
  async page(
    chat: Pick<CopilotChatRow, 'id' | 'user_id' | 'bot_id' | 'history_imported_at'>,
    opts: { before?: number; turns?: number },
    loadCheckpoint: () => Promise<BaseMessage[]>,
  ): Promise<ChatHistoryPageOut> {
    if (!chat.history_imported_at) await this.importIfFirst(chat, loadCheckpoint);
    const { rows, hasMore } = await this.deps.messages.listTurnsPage(chat.id, {
      before: opts.before,
      turns: opts.turns ?? CHAT_HISTORY_PAGE_TURNS,
    });
    return {
      messages: await this.withFeedback(chat, rows),
      nextCursor: hasMore && rows.length > 0 ? rows[0].seq : null,
    };
  }

  /**
   * The page's messages, each reply carrying the id of the question that
   * started its turn and the user's feedback on it. A page never splits a
   * turn, so a reply's question is the nearest user row before it; replies
   * ahead of the page's first question have none. One query for the page's
   * feedback, whatever its size.
   */
  private async withFeedback(
    chat: Pick<CopilotChatRow, 'user_id'>,
    rows: CopilotMessageRow[],
  ): Promise<UIMessageOut[]> {
    const questionIds: (string | null)[] = [];
    let question: string | null = null;
    for (const row of rows) {
      if (row.role === 'user') question = row.id;
      questionIds.push(row.role === 'assistant' ? question : null);
    }
    const asked = [...new Set(questionIds.filter((id): id is string => id !== null))];
    const votes = await this.deps.feedback.findByMessageIds(chat.user_id, asked);
    const voteByQuestion = new Map(votes.map((v) => [v.message_id, toResponseFeedbackValue(v)]));
    return rows.map((row, i) => {
      const message = this.toUIMessage(row);
      const questionId = questionIds[i];
      if (!questionId) return message;
      const feedback = voteByQuestion.get(questionId);
      return {
        ...message,
        metadata: { ...message.metadata, questionId, ...(feedback ? { feedback } : {}) },
      };
    });
  }

  /** Copy the checkpoint into rows once per thread. True when this call did it. */
  private async importIfFirst(
    chat: Pick<CopilotChatRow, 'id' | 'user_id' | 'bot_id'>,
    load: () => Promise<BaseMessage[]>,
  ): Promise<boolean> {
    if (!(await this.deps.chats.claimHistoryImport(chat.id))) {
      await this.waitForPeerHistoryImport(chat.id);
      return false;
    }
    try {
      const ui = toUIMessages(await load());
      const inserted = await this.deps.messages.insertMany(this.toRows(chat, ui, null));
      await this.embed(inserted);
      return true;
    } catch (err) {
      await this.deps.chats.clearHistoryImport(chat.id);
      throw err;
    }
  }

  /**
   * Another request claimed the import: wait until it finishes so a page load
   * does not return an empty thread while rows are still being inserted.
   */
  private async waitForPeerHistoryImport(chatId: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const row = await this.deps.chats.getById(chatId);
      if (!row?.history_imported_at) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const { rows } = await this.deps.messages.listPage(chatId, { limit: 1 });
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 100));
      if (i >= 2) return;
    }
  }

  private async embed(inserted: Pick<CopilotMessageRow, 'id' | 'role'>[]): Promise<void> {
    const ids = inserted.filter((r) => r.role === 'assistant').map((r) => r.id);
    if (ids.length === 0) return;
    try {
      await this.deps.dispatchEmbedding(ids);
    } catch (err) {
      // Search falls back to full text for an exchange that never got a vector.
      console.error('[chat-history] failed to queue embeddings:', err);
    }
  }

  /**
   * Queue the embedding of stored exchanges that have none — the cron sweep's
   * backfill (`sweepUnembeddedChatMessages`). Returns how many were queued.
   */
  async queueEmbeddings(messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    await this.deps.dispatchEmbedding(messageIds);
    return messageIds.length;
  }

  /**
   * UI messages → rows. An assistant row's text is the whole exchange — the
   * question before it plus the answer — so one row is one searchable unit.
   */
  private toRows(
    chat: Pick<CopilotChatRow, 'id' | 'user_id' | 'bot_id'>,
    ui: UIMessageOut[],
    authorBotId: string | null,
  ): NewCopilotMessage[] {
    let lastUserText = '';
    return ui.map((m) => {
      const text = partText(m.parts);
      const parts: unknown[] = [...m.parts];
      const attachments = m.experimental_attachments ?? [];
      if (
        attachments.length > 0 &&
        attachments.reduce((n, a) => n + a.url.length, 0) <= MAX_STORED_ATTACHMENT_CHARS
      ) {
        parts.push({ type: ATTACHMENTS_PART, data: attachments } satisfies StoredAttachments);
      }
      const fromBot = m.metadata?.fromBot;
      if (fromBot) parts.push({ type: FROM_BOT_PART, data: fromBot } satisfies StoredFromBot);
      const fromRoutine = m.metadata?.fromRoutine;
      if (fromRoutine) parts.push({ type: FROM_ROUTINE_PART, data: fromRoutine } satisfies StoredFromRoutine);
      if (m.role === 'user') {
        lastUserText = text;
        return {
          chat_id: chat.id,
          user_id: chat.user_id,
          bot_id: chat.bot_id,
          role: 'user',
          // A user's own @mention is still the user's message.
          author_bot_id: fromBot && fromBot.kind !== 'user_mention' ? fromBot.id : authorBotId,
          parts,
          text,
        };
      }
      return {
        chat_id: chat.id,
        user_id: chat.user_id,
        bot_id: chat.bot_id,
        role: 'assistant',
        parts,
        text: lastUserText ? `Q: ${lastUserText}\n\nA: ${text}` : text,
      };
    });
  }

  private toUIMessage(row: CopilotMessageRow): UIMessageOut {
    const stored = (row.parts ?? []) as StoredPart[];
    const attachments = stored.find((p): p is StoredAttachments => p.type === ATTACHMENTS_PART);
    const fromBot = stored.find((p): p is StoredFromBot => p.type === FROM_BOT_PART)?.data;
    const fromRoutine = stored.find((p): p is StoredFromRoutine => p.type === FROM_ROUTINE_PART)?.data;
    const parts = stored.filter(
      (p): p is UIPart =>
        p.type !== ATTACHMENTS_PART && p.type !== FROM_BOT_PART && p.type !== FROM_ROUTINE_PART,
    );
    return {
      id: row.id,
      role: row.role,
      parts,
      ...(attachments?.data?.length ? { experimental_attachments: attachments.data } : {}),
      metadata: {
        ...(fromBot ? { fromBot } : {}),
        ...(fromRoutine ? { fromRoutine } : {}),
        createdAt: row.created_at,
      },
    };
  }
}
