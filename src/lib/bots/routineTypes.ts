/**
 * Bot routines (client-safe types): a scheduled message a bot sends itself on
 * a user's behalf. Stored in `routines` with `bot_id` set; fired by the same
 * per-minute tick as workforce routines (`@/lib/routines/fire`).
 */
import type { ScheduleKind } from '@/lib/routines/schedule';

export const BOT_ROUTINE_TITLE_MAX_LENGTH = 120;
export const BOT_ROUTINE_PROMPT_MAX_LENGTH = 4000;

/** What creating (or fully re-scheduling) a routine takes. */
export interface BotRoutineInput {
  title: string;
  /** The message sent to the bot, as the routine's creator, each time it fires. */
  prompt: string;
  schedule_kind: ScheduleKind;
  schedule_spec: Record<string, unknown>;
  /** IANA timezone the schedule's times are in. */
  timezone: string;
}

export type BotRoutinePatch = Partial<BotRoutineInput> & { enabled?: boolean };

export interface BotRoutineDto extends BotRoutineInput {
  id: string;
  bot_id: string;
  enabled: boolean;
  /** The schedule in words ("Weekdays at 09:00 (Asia/Jakarta)"). */
  schedule_label: string;
  next_fire_at: string | null;
  last_fired_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  /** The requesting user created it: it runs as them, in their chat. */
  is_mine: boolean;
  created_at: string;
}
