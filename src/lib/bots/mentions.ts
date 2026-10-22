/**
 * @mentions between bots. A message that names a bot as `@Name` — typed by
 * the user, or written by a bot in its reply — is handed to that bot, which
 * answers in its own chat with the user (`BotService.dispatchMentions`).
 *
 * Pure and client-safe: the composer's autocomplete and the transcript's
 * "Pinged" footer use the same matching as the server.
 */

/**
 * At most this many bots are pinged by one bot reply. A user's message has no
 * cap: every bot the user @mentions is pinged.
 */
export const MAX_MENTION_PINGS = 3;

export interface MentionableBot {
  id: string;
  name: string;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** `@` starts a mention only at the start of the text or after a non-word character (not `a@b.com`). */
function startsMention(text: string, at: number): boolean {
  return text[at] === '@' && (at === 0 || !WORD_CHAR.test(text[at - 1]));
}

/**
 * The bots a text @mentions, in order of first mention, each once, without
 * `excludeId` (the sender), capped at `limit` (default `MAX_MENTION_PINGS`;
 * pass `Infinity` for a user's message). Names match
 * case-insensitively, longest first, so "@Deal Scout" is Deal Scout and not a
 * bot called "Deal"; the name must end at a word boundary.
 */
export function findBotMentions<T extends MentionableBot>(
  text: string,
  bots: readonly T[],
  opts: { excludeId?: string | null; limit?: number } = {},
): T[] {
  const limit = opts.limit ?? MAX_MENTION_PINGS;
  const candidates = bots
    .filter((b) => b.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const found: T[] = [];
  for (let i = 0; i < text.length && found.length < limit; i++) {
    if (!startsMention(text, i)) continue;
    const rest = text.slice(i + 1).toLowerCase();
    const bot = candidates.find((b) => {
      const name = b.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest.charAt(name.length);
      return after === '' || !WORD_CHAR.test(after);
    });
    if (!bot) continue;
    i += bot.name.length;
    if (bot.id === opts.excludeId || found.some((f) => f.id === bot.id)) continue;
    found.push(bot);
  }
  return found;
}

/** The longest partial mention the composer completes. */
const MAX_QUERY_LENGTH = 40;

/**
 * The mention being typed at the caret: the `@` and the text after it, up to
 * the caret, if it is on one line and no longer than a bot name could be.
 * `start` is the index of the `@`. Null when the caret is not in a mention.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_QUERY_LENGTH + 1; i--) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch === '@') {
      if (!startsMention(text, i)) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
  }
  return null;
}

/**
 * Whether the query is a mention already finished: a bot's full name followed
 * by whitespace (what picking a bot inserts), and no longer name still being
 * typed past it ("@Deal " stays open while "Deal Scout" exists).
 */
export function isCompletedMention(bots: readonly MentionableBot[], query: string): boolean {
  if (!/\s$/.test(query)) return false;
  const typed = query.toLowerCase();
  const name = typed.trimEnd();
  return (
    bots.some((b) => b.name.toLowerCase() === name) &&
    !bots.some((b) => b.name.toLowerCase().startsWith(typed))
  );
}

/** Whether the input still contains `@query` at `start` (a picked mention unchanged). */
export function mentionInsertAt(input: string, start: number, query: string): boolean {
  const insert = `@${query}`;
  return input.slice(start, start + insert.length) === insert;
}

/** The bots whose names start with (then contain) the query, case-insensitive. */
export function filterMentionCandidates<T extends MentionableBot>(bots: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...bots];
  const starts = bots.filter((b) => b.name.toLowerCase().startsWith(q));
  const contains = bots.filter((b) => !starts.includes(b) && b.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/**
 * The per-turn note telling a bot which other bots it can hand work to. Empty
 * when there are none. Per turn rather than in the persona, so the bot list
 * can change without touching the (pinned) system prompt.
 */
export function mentionableBotsContext(bots: readonly MentionableBot[], selfId: string): string {
  const others = bots.filter((b) => b.id !== selfId).map((b) => b.name);
  if (others.length === 0) return '';
  return [
    '<other_bots>',
    `The user also has these bots: ${others.join(', ')}.`,
    `To hand one of them a task, first call lookup_bot to pick the one whose persona fits, then write @ followed by its exact name in your reply (e.g. @${others[0]}). It receives your reply as a message from you, and its answer comes back to you here as a "Reply from …" message that starts your next turn — relay it to the user then. Until it arrives, say who you asked and that you are waiting; do not send the user to the other bot's chat. Mention a bot only when you want it to act; at most ${MAX_MENTION_PINGS} per reply.`,
    '</other_bots>',
  ].join('\n');
}
