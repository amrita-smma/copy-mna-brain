/** A bot's task log (client-safe types). */

export type BotTaskSource = 'chat' | 'mention' | 'routine';

export interface BotTaskDto {
  id: string;
  /** How the task reached the bot: the user's chat, an @mention, or a routine. */
  source: BotTaskSource;
  /** What the bot did, in one line. */
  summary: string;
  created_at: string;
  routine_id: string | null;
  routine_title: string | null;
  /** The task was done for the requesting user (their chat, or a routine run as them). */
  is_mine: boolean;
}

export interface BotTaskPage {
  items: BotTaskDto[];
  /** Pass as `before` for the next (older) page; null at the start of the log. */
  nextCursor: string | null;
}
