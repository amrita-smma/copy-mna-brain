import type { BotRoutineRow, BotRow, RoutineRow, RoutinesRepository } from '@/lib/repositories';
import { computeNextFireAt, normalizeSchedule, type ScheduleKind } from '@/lib/routines/schedule';
import { describeSchedule } from '@/lib/routines/describe';
import {
  BOT_ROUTINE_PROMPT_MAX_LENGTH,
  BOT_ROUTINE_TITLE_MAX_LENGTH,
  type BotRoutineDto,
  type BotRoutineInput,
  type BotRoutinePatch,
} from '@/lib/bots/routineTypes';
import { BotNotFoundError, type BotMessageJob, type BotService } from './botService';

const SCHEDULE_KINDS: readonly ScheduleKind[] = ['daily', 'weekly', 'monthly', 'cron'];

export class BotRoutineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotRoutineValidationError';
  }
}

export class BotRoutineNotFoundError extends Error {
  constructor(message = 'Routine not found') {
    super(message);
    this.name = 'BotRoutineNotFoundError';
  }
}

export interface BotRoutineDeps {
  routinesRepo: RoutinesRepository;
  botService: BotService;
  /** Whether the user still belongs to this workspace (a routine runs as its creator). */
  isMember(userId: string): Promise<boolean>;
  /** Queue the bot's background turn for a routine's message (`bot_routine` job). */
  dispatchBotMessage(job: BotMessageJob): Promise<unknown>;
}

/** What firing one due routine did. */
export type BotRoutineFireOutcome =
  | { status: 'fired' }
  | { status: 'skipped'; reason: string }
  | { status: 'paused'; reason: string };

/** A validated routine: its schedule normalized and its first fire computed. */
interface ValidRoutine extends BotRoutineInput {
  cron_expression: string;
  next_fire_at: string;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BotRoutineValidationError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new BotRoutineValidationError(`${field} must be at most ${max} characters`);
  return trimmed;
}

/** The schedule and timezone, checked by actually computing the next fire. */
function schedule(
  kind: unknown,
  spec: unknown,
  timezone: unknown,
  from: Date,
): Pick<ValidRoutine, 'schedule_kind' | 'schedule_spec' | 'timezone' | 'cron_expression' | 'next_fire_at'> {
  if (typeof kind !== 'string' || !SCHEDULE_KINDS.includes(kind as ScheduleKind)) {
    throw new BotRoutineValidationError('Schedule must be daily, weekly, monthly or cron');
  }
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new BotRoutineValidationError('Schedule details are required');
  }
  const tz = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC';
  try {
    const normalized = normalizeSchedule(kind as ScheduleKind, spec as never);
    const next = computeNextFireAt(normalized.cronExpression, tz, from, {
      kind: kind as ScheduleKind,
      spec: normalized.scheduleSpec,
    });
    return {
      schedule_kind: kind as ScheduleKind,
      schedule_spec: normalized.scheduleSpec,
      timezone: tz,
      cron_expression: normalized.cronExpression,
      next_fire_at: next,
    };
  } catch (err) {
    throw new BotRoutineValidationError(err instanceof Error ? err.message : 'Invalid schedule');
  }
}

/** The next fire strictly after the one being credited (monthly clamping honoured). */
function nextFireAfter(routine: RoutineRow, now: Date): string {
  return computeNextFireAt(routine.cron_expression, routine.timezone, new Date(routine.next_fire_at ?? now.toISOString()), {
    kind: routine.schedule_kind as ScheduleKind,
    spec: routine.schedule_spec,
  });
}

/**
 * Bot routines: a scheduled message a bot gets on a user's behalf. Stored in
 * `routines` with `bot_id` set and fired by the same per-minute tick as
 * workforce routines, but instead of queueing a workforce run the routine's
 * prompt is sent to the bot *as the routine's creator*, in the creator's own
 * chat with the bot — exactly as if they had typed it — and answered in the
 * background (`bot_routine` job).
 *
 * Who manages a bot's routines is who may edit the bot: its owner for a
 * private bot, anyone in the workspace for a shared one. So a shared bot's
 * routines are shared too — everyone sees them and can change them — while
 * each still runs as the person who created it. Brain Bot is nobody's to
 * edit but everyone's own: each user sees and manages only the routines they
 * made on it.
 */
/** Brain Bot's routines are each user's own; other bots' are the bot's. */
function scopeFor(bot: Pick<BotRow, 'is_default'>, userId: string): { createdBy?: string } {
  return bot.is_default ? { createdBy: userId } : {};
}

export class BotRoutineService {
  constructor(private readonly deps: BotRoutineDeps) {}

  async list(userId: string, botId: string): Promise<BotRoutineDto[]> {
    const bot = await this.deps.botService.findVisibleRow(userId, botId);
    const rows = await this.deps.routinesRepo.listForBot(bot.id, scopeFor(bot, userId));
    return rows.map((row) => this.toDto(row, userId));
  }

  /**
   * A routine's input checked on its own, for a bot that does not exist yet
   * (`propose_create_bot` proposing the routines a new bot starts with).
   * Permission is checked when the card creates them, bot by bot.
   */
  validateInput(input: Partial<Record<keyof BotRoutineInput, unknown>>): { routine: BotRoutineInput; label: string } {
    const routine = this.validate(input);
    return {
      routine: {
        title: routine.title,
        prompt: routine.prompt,
        schedule_kind: routine.schedule_kind,
        schedule_spec: routine.schedule_spec,
        timezone: routine.timezone,
      },
      label: describeSchedule(routine.schedule_kind, routine.schedule_spec, routine.timezone),
    };
  }

  /**
   * The routine `create` would make, validated and permission-checked but not
   * written: for the propose_create_routine approval card.
   */
  async preview(
    userId: string,
    botId: string,
    input: Partial<Record<keyof BotRoutineInput, unknown>>,
  ): Promise<{ bot: BotRow; routine: ValidRoutine; label: string }> {
    const bot = await this.editableBot(userId, botId);
    const routine = this.validate(input);
    return { bot, routine, label: describeSchedule(routine.schedule_kind, routine.schedule_spec, routine.timezone) };
  }

  async create(
    userId: string,
    botId: string,
    input: Partial<Record<keyof BotRoutineInput, unknown>>,
  ): Promise<BotRoutineDto> {
    const bot = await this.editableBot(userId, botId);
    const routine = this.validate(input);
    const row = await this.deps.routinesRepo.create({
      bot_id: bot.id,
      title: routine.title,
      prompt: routine.prompt,
      schedule_kind: routine.schedule_kind,
      schedule_spec: routine.schedule_spec,
      cron_expression: routine.cron_expression,
      timezone: routine.timezone,
      next_fire_at: routine.next_fire_at,
      enabled: true,
      agent_name: null,
      created_by: userId,
      updated_by: userId,
    });
    return this.toDto({ ...row, created_by_name: null }, userId);
  }

  async update(userId: string, botId: string, id: string, patch: BotRoutinePatch): Promise<BotRoutineDto> {
    const bot = await this.editableBot(userId, botId);
    const existing = await this.find(bot, id, userId);
    const next: Record<string, unknown> = { updated_by: userId };
    if (patch.title !== undefined) next.title = text(patch.title, 'Title', BOT_ROUTINE_TITLE_MAX_LENGTH);
    if (patch.prompt !== undefined) next.prompt = text(patch.prompt, 'Message', BOT_ROUTINE_PROMPT_MAX_LENGTH);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new BotRoutineValidationError('Enabled must be true or false');
      next.enabled = patch.enabled;
    }
    const rescheduled =
      patch.schedule_kind !== undefined || patch.schedule_spec !== undefined || patch.timezone !== undefined;
    // A new schedule, or switching a paused routine back on, counts from now:
    // a resumed routine must not fire for every window it missed.
    if (rescheduled || (patch.enabled === true && !existing.enabled)) {
      const s = schedule(
        patch.schedule_kind ?? existing.schedule_kind,
        patch.schedule_spec ?? existing.schedule_spec,
        patch.timezone ?? existing.timezone,
        new Date(),
      );
      Object.assign(next, s);
    }
    const row = await this.deps.routinesRepo.update(existing.id, next);
    return this.toDto({ ...row, created_by_name: existing.created_by_name }, userId);
  }

  async archive(userId: string, botId: string, id: string): Promise<void> {
    const bot = await this.editableBot(userId, botId);
    const existing = await this.find(bot, id, userId);
    await this.deps.routinesRepo.archive(existing.id);
  }

  /**
   * Send the routine's message now, as the user asking (in their own chat
   * with the bot). The schedule is left alone.
   */
  async runNow(userId: string, botId: string, id: string): Promise<void> {
    const bot = await this.deps.botService.findVisibleRow(userId, botId);
    const routine = await this.find(bot, id, userId);
    await this.deps.dispatchBotMessage(this.job(routine, userId, bot.id));
  }

  /**
   * Fire one due routine from the cron tick. The routine runs as its creator,
   * so it pauses — rather than run as someone who may no longer see the bot —
   * when the bot is gone, the creator lost access to it, or left the
   * workspace. Of two ticks that claimed the same due routine, only the one
   * whose conditional advance wins sends the message.
   */
  async fire(routine: RoutineRow, now: Date): Promise<BotRoutineFireOutcome> {
    const creator = routine.created_by;
    const pause = async (reason: string): Promise<BotRoutineFireOutcome> => {
      await this.deps.routinesRepo.pause(routine.id);
      return { status: 'paused', reason };
    };
    if (!routine.bot_id) return { status: 'skipped', reason: 'not a bot routine' };
    if (!creator) return pause('routine has no creator to run as');
    if (!(await this.deps.isMember(creator))) return pause('its creator left the workspace');
    let bot: BotRow;
    try {
      bot = await this.deps.botService.findVisibleRow(creator, routine.bot_id);
    } catch (err) {
      if (err instanceof BotNotFoundError) return pause('the bot is archived or no longer visible to its creator');
      throw err;
    }
    const dueAt = routine.next_fire_at;
    if (!dueAt) return { status: 'skipped', reason: 'routine has no next fire time' };
    const nextFireAt = nextFireAfter(routine, now);
    const priorLastFired = routine.last_fired_at;
    const won = await this.deps.routinesRepo.advanceIfDue(routine.id, dueAt, now, nextFireAt);
    if (!won) return { status: 'skipped', reason: 'already fired by another tick' };
    try {
      await this.deps.dispatchBotMessage(this.job(routine, creator, bot.id));
    } catch (err) {
      await this.deps.routinesRepo.revertFireAdvance(routine.id, nextFireAt, dueAt, priorLastFired);
      throw err;
    }
    return { status: 'fired' };
  }

  private job(routine: Pick<RoutineRow, 'id' | 'title' | 'prompt'>, userId: string, botId: string): BotMessageJob {
    return {
      userId,
      origin: { kind: 'routine', routine: { id: routine.id, title: routine.title } },
      toBotId: botId,
      text: routine.prompt,
    };
  }

  /** A bot whose routines the user may manage: one they may edit, or Brain Bot (their own routines on it). */
  private async editableBot(userId: string, botId: string): Promise<BotRow> {
    const bot = await this.deps.botService.findVisibleRow(userId, botId);
    if (!bot.is_default) this.deps.botService.assertCanEdit(userId, bot);
    return bot;
  }

  private async find(bot: BotRow, id: string, userId: string): Promise<BotRoutineRow> {
    const row = await this.deps.routinesRepo.findForBot(bot.id, id, scopeFor(bot, userId));
    if (!row) throw new BotRoutineNotFoundError();
    return row;
  }

  private validate(input: Partial<Record<keyof BotRoutineInput, unknown>>): ValidRoutine {
    return {
      title: text(input.title, 'Title', BOT_ROUTINE_TITLE_MAX_LENGTH),
      prompt: text(input.prompt, 'Message', BOT_ROUTINE_PROMPT_MAX_LENGTH),
      ...schedule(input.schedule_kind, input.schedule_spec, input.timezone, new Date()),
    };
  }

  private toDto(row: BotRoutineRow, userId: string): BotRoutineDto {
    const kind = row.schedule_kind as ScheduleKind;
    return {
      id: row.id,
      bot_id: row.bot_id ?? '',
      title: row.title,
      prompt: row.prompt,
      schedule_kind: kind,
      schedule_spec: row.schedule_spec,
      timezone: row.timezone,
      schedule_label: describeSchedule(kind, row.schedule_spec, row.timezone),
      enabled: row.enabled,
      next_fire_at: row.next_fire_at,
      last_fired_at: row.last_fired_at,
      created_by: row.created_by,
      created_by_name: row.created_by_name,
      is_mine: row.created_by === userId,
      created_at: row.created_at,
    };
  }
}
