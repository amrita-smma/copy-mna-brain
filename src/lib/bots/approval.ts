/**
 * The payloads bot tools hand to the chat transcript (client safe). They ride
 * in the tool's text output as an encoded marker (`encodeApprovalMarker`), the
 * same wire format the insight approval cards use.
 *
 * - `BOT_CHANGE_APPROVAL_MARKER`: propose_create_bot, and update_bot for any
 *   change to a bot that is shared before or after it (with `warning`; a
 *   private bot's changes are written at once). The card shows the change
 *   and, on Approve, sends `input` to the bots API — which checks the user's
 *   permission again.
 * - `BOT_ROUTINE_APPROVAL_MARKER`: propose_create_routine. The card shows the
 *   routine and, on Approve, creates it through the bot routines API.
 * - `BOT_MESSAGE_MARKER`: the retired message_bot tool. Kept so chat history
 *   from before @mentions still shows the card linking to the other bot.
 */
import type { BotAvatarConfig, BotVisibility } from './types';
import type { BotRoutineInput } from './routineTypes';

export const BOT_CHANGE_APPROVAL_MARKER = 'BOT_CHANGE_APPROVAL_JSON';
export const BOT_MESSAGE_MARKER = 'BOT_MESSAGE_JSON';
export const BOT_ROUTINE_APPROVAL_MARKER = 'BOT_ROUTINE_APPROVAL_JSON';

export interface BotRoutineApprovalPayload {
  approval_id: string;
  bot_id: string;
  bot_name: string;
  /** The bot is shared: everyone in the workspace sees and can edit its routines. */
  shared: boolean;
  /** The routine's schedule in words. */
  schedule_label: string;
  /** The body Approve sends to the bot routines API. */
  input: BotRoutineInput;
}

/** The fields a bot change shows and sends. */
export interface BotChangeFields {
  name: string;
  avatar: Required<BotAvatarConfig>;
  persona_md: string;
  visibility: BotVisibility;
}

/** A routine a new bot starts with (create only): what Approve sends, and its schedule in words. */
export interface ProposedBotRoutine {
  label: string;
  input: BotRoutineInput;
}

export interface BotChangeApprovalPayload {
  approval_id: string;
  action: 'create' | 'update';
  /** The bot being changed (update only). */
  bot_id?: string;
  /** The bot as it is now (update only). */
  before?: BotChangeFields;
  after: BotChangeFields;
  /** Only the fields that change: the body Approve sends to the bots API. */
  input: Partial<BotChangeFields>;
  /** Create only: routines Approve schedules on the new bot, in order. */
  routines?: ProposedBotRoutine[];
  /**
   * Why this change needs confirming rather than just applying: the persona
   * of a shared bot changes it for everyone. Shown as an alert on the card.
   */
  warning?: string;
}

export interface BotMessagePayload {
  bot_id: string;
  name: string;
  avatar: Required<BotAvatarConfig>;
  message: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRoutineInput(v: unknown): v is BotRoutineInput {
  return (
    isObject(v) &&
    typeof v.title === 'string' &&
    typeof v.prompt === 'string' &&
    typeof v.schedule_kind === 'string' &&
    isObject(v.schedule_spec) &&
    typeof v.timezone === 'string'
  );
}

export function isBotChangeApprovalPayload(v: unknown): v is BotChangeApprovalPayload {
  return (
    isObject(v) &&
    (v.action === 'create' || v.action === 'update') &&
    typeof v.approval_id === 'string' &&
    isObject(v.after) &&
    typeof v.after.name === 'string' &&
    isObject(v.input) &&
    (v.action === 'create' || typeof v.bot_id === 'string') &&
    (v.routines === undefined ||
      (Array.isArray(v.routines) &&
        v.routines.every((r) => isObject(r) && typeof r.label === 'string' && isRoutineInput(r.input))))
  );
}

export function isBotMessagePayload(v: unknown): v is BotMessagePayload {
  return (
    isObject(v) &&
    typeof v.bot_id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.message === 'string' &&
    isObject(v.avatar)
  );
}

export function isBotRoutineApprovalPayload(v: unknown): v is BotRoutineApprovalPayload {
  return (
    isObject(v) &&
    typeof v.approval_id === 'string' &&
    typeof v.bot_id === 'string' &&
    typeof v.bot_name === 'string' &&
    typeof v.schedule_label === 'string' &&
    isObject(v.input) &&
    typeof v.input.title === 'string' &&
    typeof v.input.prompt === 'string' &&
    typeof v.input.schedule_kind === 'string' &&
    isObject(v.input.schedule_spec) &&
    typeof v.input.timezone === 'string'
  );
}
