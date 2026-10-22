/**
 * A bot's memory of one user (client safe): the notes the user asked that
 * bot to keep about them — preferences, standing requests, how they want to
 * be answered. One list per user per bot (`bot_user_memories`), seen and
 * used only in that user's chats with that bot. Distinct from the persona,
 * which is how the bot behaves for everyone, and from the mem0 memory, which
 * is about the person across every bot.
 */

export interface BotMemoryNote {
  text: string;
  /** When the note was saved (ISO). */
  created_at: string;
}

export interface BotMemoryDto {
  bot_id: string;
  notes: BotMemoryNote[];
}

/** Notes one bot keeps about one user, at most. */
export const BOT_MEMORY_MAX_NOTES = 50;
/** Characters per note, at most: a note is one preference, not a document. */
export const BOT_MEMORY_NOTE_MAX_LENGTH = 300;

/** A note's text as stored: single-spaced, trimmed. */
export function normalizeNoteText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The same note said twice: case, spacing and trailing punctuation aside. */
export function sameNote(a: string, b: string): boolean {
  const key = (s: string) => normalizeNoteText(s).toLowerCase().replace(/[.!]+$/, '');
  return key(a) === key(b);
}
