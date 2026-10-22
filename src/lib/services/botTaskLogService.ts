import type { BotTaskLogCursor, BotTaskLogListRow, BotTaskLogRepository, BotTaskLogRow } from '@/lib/repositories';
import type { BotTaskDto, BotTaskPage, BotTaskSource } from '@/lib/bots/taskLogTypes';
import { TASK_ANSWER_MAX_CHARS, TASK_QUESTION_MAX_CHARS } from '@/lib/bots/taskSummary';
import type { BotService } from './botService';

/** Task log rows per page when the caller doesn't ask for a size. */
export const BOT_TASK_PAGE_SIZE = 30;
const BOT_TASK_PAGE_MAX = 100;

/** One finished bot turn, to be summarized into the bot's task log. */
export interface BotTaskEntry {
  botId: string;
  userId: string;
  chatId: string | null;
  source: BotTaskSource;
  routine: { id: string; title: string } | null;
  question: string;
  answer: string;
  toolNames: string[];
}

export interface BotTaskLogDeps {
  repo: BotTaskLogRepository;
  botService: BotService;
  /** Queue the summary job (`bot_task_summary`) for a finished turn. */
  dispatchSummary(entry: BotTaskEntry): Promise<unknown>;
}

function encodeCursor(row: Pick<BotTaskLogRow, 'created_at' | 'id'>): string {
  return `${row.created_at}|${row.id}`;
}

function decodeCursor(cursor: string | undefined): BotTaskLogCursor | undefined {
  if (!cursor) return undefined;
  const at = cursor.lastIndexOf('|');
  if (at <= 0) return undefined;
  const createdAt = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  return Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id) ? undefined : { createdAt, id };
}

/**
 * A bot's task log: a one-line summary of each task it did, whether the user
 * asked in its chat, another bot or the user @mentioned it, or a routine sent
 * it. Every finished turn is queued for summary (`record`); the summary job
 * stores a line unless the turn was small talk (`store`).
 *
 * A reader sees the tasks done for them plus every routine run: on a shared
 * bot the routines are shared, while other people's chats stay private.
 */
export class BotTaskLogService {
  constructor(private readonly deps: BotTaskLogDeps) {}

  /** Queue a finished turn for summary. Nothing to log for a turn with no answer. */
  async record(entry: BotTaskEntry): Promise<void> {
    if (!entry.answer.trim()) return;
    await this.deps.dispatchSummary({
      ...entry,
      question: entry.question.slice(0, TASK_QUESTION_MAX_CHARS),
      answer: entry.answer.slice(0, TASK_ANSWER_MAX_CHARS),
    });
  }

  /** Store a summarized task (from the summary job). */
  async store(entry: BotTaskEntry, summary: string): Promise<BotTaskLogRow> {
    return this.deps.repo.insert({
      bot_id: entry.botId,
      user_id: entry.userId,
      chat_id: entry.chatId,
      routine_id: entry.routine?.id ?? null,
      source: entry.source,
      summary,
    });
  }

  async list(userId: string, botId: string, opts: { before?: string; limit?: number } = {}): Promise<BotTaskPage> {
    const bot = await this.deps.botService.findVisibleRow(userId, botId);
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? BOT_TASK_PAGE_SIZE), 1), BOT_TASK_PAGE_MAX);
    const { rows, hasMore } = await this.deps.repo.listForUser(bot.id, userId, {
      before: decodeCursor(opts.before),
      limit,
      // Brain Bot's routines are each user's own, so only their runs show.
      ownOnly: bot.is_default,
    });
    return {
      items: rows.map((row) => this.toDto(row, userId)),
      nextCursor: hasMore && rows.length > 0 ? encodeCursor(rows[rows.length - 1]) : null,
    };
  }

  private toDto(row: BotTaskLogListRow, userId: string): BotTaskDto {
    return {
      id: row.id,
      source: row.source,
      summary: row.summary,
      created_at: row.created_at,
      routine_id: row.routine_id,
      routine_title: row.routine_title,
      is_mine: row.user_id === userId,
    };
  }
}
