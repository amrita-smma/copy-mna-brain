/**
 * The bots' live state as the browser sees it (client safe). The server side
 * (`./presence`) writes it to Redis; `GET /api/bots/events` streams it.
 */
import type { BotDto } from './types';

/**
 * What a bot is doing right now: `thinking` / `working` (a tool runs) /
 * `talking` (writing the answer), from the running turn. A bot that handed
 * work to another bot and is waiting for the answer shows nothing.
 */
export type BotPhase = 'thinking' | 'working' | 'talking';

/** A bot's running turn, keyed by the user's chat with it. Expires if the turn dies. */
export interface BotPresence {
  chatId: string;
  botId: string;
  userId: string;
  phase: BotPhase;
  /** ISO time the turn started. */
  since: string;
  /** The turn's id; a client ignores presence for its own live turn. */
  turnId: string;
}

/** Everything the stream sends. `snapshot` is authoritative; the rest are deltas. */
export type BotLiveEvent =
  | { type: 'snapshot'; bots: BotDto[]; presence: BotPresence[] }
  | { type: 'presence'; chatId: string; botId: string; turnId: string; phase: BotPhase | null }
  /** A turn was stored in the thread: reload it if it is on screen, else it is unread. */
  | { type: 'reply'; chatId: string; botId: string; turnId: string }
  /** A bot was created, changed, archived or re-pinned: re-read the list. */
  | { type: 'bots-changed' };

export function isBotLiveEvent(value: unknown): value is BotLiveEvent {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'snapshot' || type === 'presence' || type === 'reply' || type === 'bots-changed';
}
