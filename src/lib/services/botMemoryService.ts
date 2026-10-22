import type { BotMemoryRepository } from '@/lib/repositories/botMemoryRepository';
import type { BotRow } from '@/lib/repositories/botRepository';
import {
  BOT_MEMORY_MAX_NOTES,
  BOT_MEMORY_NOTE_MAX_LENGTH,
  normalizeNoteText,
  sameNote,
  type BotMemoryNote,
} from '@/lib/bots/memoryTypes';
import { BotValidationError } from './botService';

export interface BotMemoryDeps {
  repo: BotMemoryRepository;
  /** The bot, if the user can see it (`BotService.findVisibleRow`): a hidden bot is not found. */
  bots: { findVisibleRow(userId: string, botId: string): Promise<BotRow> };
  now?: () => Date;
}

/**
 * What a bot remembers about one user: the notes that user asked it to keep
 * (preferences, standing requests, how to answer), kept per user per bot and
 * read into that user's turns with that bot only. Anyone who can see a bot
 * has their own notes on it — a shared bot included — because the notes are
 * about the user, not the bot; the bot's persona is the owner's business.
 * Every write rewrites the list under the row's lock (`repo.update`), so the
 * bot's tool and the Memory tab cannot lose each other's notes.
 */
export class BotMemoryService {
  constructor(private readonly deps: BotMemoryDeps) {}

  async list(userId: string, botId: string): Promise<BotMemoryNote[]> {
    await this.deps.bots.findVisibleRow(userId, botId);
    return (await this.deps.repo.find(botId, userId))?.notes ?? [];
  }

  /**
   * Add notes. A note already there (same words) is skipped, not doubled; the
   * list is capped, and a cap hit says so rather than dropping older notes.
   */
  async remember(
    userId: string,
    botId: string,
    texts: readonly unknown[],
  ): Promise<{ notes: BotMemoryNote[]; added: BotMemoryNote[]; skipped: string[] }> {
    const incoming = texts.map((t) => this.validateNote(t));
    if (incoming.length === 0) throw new BotValidationError('Nothing to remember');
    await this.deps.bots.findVisibleRow(userId, botId);
    const at = this.now();
    let added: BotMemoryNote[] = [];
    let skipped: string[] = [];
    const notes = await this.deps.repo.update(botId, userId, (current) => {
      added = [];
      skipped = [];
      const next = [...current];
      for (const text of incoming) {
        if (next.some((n) => sameNote(n.text, text))) {
          skipped.push(text);
          continue;
        }
        const note = { text, created_at: at };
        next.push(note);
        added.push(note);
      }
      if (next.length > BOT_MEMORY_MAX_NOTES) {
        throw new BotValidationError(
          `A bot keeps at most ${BOT_MEMORY_MAX_NOTES} notes per person; forget some before adding more`,
        );
      }
      return added.length > 0 ? next : null;
    });
    return { notes, added, skipped };
  }

  /** Drop the notes that say these things (the same words); a note not found is reported, not an error. */
  async forget(
    userId: string,
    botId: string,
    texts: readonly unknown[],
  ): Promise<{ notes: BotMemoryNote[]; removed: BotMemoryNote[]; missing: string[] }> {
    const targets = texts.map((t) => this.validateNote(t));
    if (targets.length === 0) throw new BotValidationError('Nothing to forget');
    await this.deps.bots.findVisibleRow(userId, botId);
    let removed: BotMemoryNote[] = [];
    let missing: string[] = [];
    const notes = await this.deps.repo.update(botId, userId, (current) => {
      removed = [];
      missing = [];
      let next = current;
      for (const text of targets) {
        const hit = next.find((n) => sameNote(n.text, text));
        if (!hit) {
          missing.push(text);
          continue;
        }
        removed.push(hit);
        next = next.filter((n) => n !== hit);
      }
      return removed.length > 0 ? next : null;
    });
    return { notes, removed, missing };
  }

  /** Set the whole list (the Memory tab): existing notes keep their date, new ones get today's. */
  async replace(userId: string, botId: string, texts: unknown): Promise<BotMemoryNote[]> {
    if (!Array.isArray(texts)) throw new BotValidationError('Notes must be a list');
    if (texts.length > BOT_MEMORY_MAX_NOTES) {
      throw new BotValidationError(`A bot keeps at most ${BOT_MEMORY_MAX_NOTES} notes per person`);
    }
    const wanted = texts.map((t) => this.validateNote(t));
    await this.deps.bots.findVisibleRow(userId, botId);
    const at = this.now();
    return this.deps.repo.update(botId, userId, (current) => {
      const next: BotMemoryNote[] = [];
      for (const text of wanted) {
        if (next.some((n) => sameNote(n.text, text))) continue;
        const kept = current.find((n) => sameNote(n.text, text));
        next.push(kept ?? { text, created_at: at });
      }
      return next;
    });
  }

  /**
   * The notes as a system-context block for one of this user's turns with the
   * bot, or null when there are none. Checks the bot is the user's to see, like
   * every other read. Best-effort for callers: a lookup that fails should not
   * stop the turn.
   */
  async promptContext(userId: string, botId: string): Promise<string | null> {
    const notes = await this.list(userId, botId);
    if (notes.length === 0) return null;
    return [
      '## What this user asked you to remember',
      '',
      'Their own notes for you — preferences and standing requests, saved with update_bot. They apply to this person only; follow them, and when they change one, save the change with update_bot (remember / forget).',
      '',
      ...notes.map((n) => `- ${n.text}`),
    ].join('\n');
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private validateNote(raw: unknown): string {
    if (typeof raw !== 'string') throw new BotValidationError('A note must be text');
    const text = normalizeNoteText(raw);
    if (!text) throw new BotValidationError('A note cannot be blank');
    if (text.length > BOT_MEMORY_NOTE_MAX_LENGTH) {
      throw new BotValidationError(`A note must be at most ${BOT_MEMORY_NOTE_MAX_LENGTH} characters`);
    }
    return text;
  }
}
