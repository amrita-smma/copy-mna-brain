import { randomUUID } from 'node:crypto';
import type {
  BotPatch,
  BotRepository,
  BotRow,
  CopilotChatRow,
  CopilotChatsRepository,
  VisibleBotRow,
} from '@/lib/repositories';
import type { CopilotAgentType } from '@/lib/agents/analysis/flavors/keys';
import {
  BOT_NAME_MAX_LENGTH,
  BOT_PERSONA_MAX_LENGTH,
  BRAIN_BOT_AVATAR,
  BRAIN_BOT_NAME,
  BRAIN_BOT_PERSONA,
  DEFAULT_BOT_AVATAR,
  botGreeting,
  primaryBotName,
  isBotVisibility,
  resolveBotAvatar,
  type BotAvatarConfig,
  type BotDto,
  type BotVisibility,
} from '@/lib/bots/types';
import { personaText } from '@/lib/bots/persona';
import { findBotMentions, mentionableBotsContext } from '@/lib/bots/mentions';
import type { BotTurnOrigin } from '@/lib/bots/runBotTurn';
import type { BotChangeFields } from '@/lib/bots/approval';

/** More bots than anyone has; bounds the stored pin list. */
export const BOT_ORDER_MAX_LENGTH = 500;

/** The user's thread state for one bot, as the list reads it. */
type BotThreadState = Pick<VisibleBotRow, 'chat_id' | 'unread' | 'busy' | 'pinned' | 'last_activity_at' | 'last_message'>;

/** A bot the list did not read thread state for (a create, an edit, a lookup). */
const NO_THREAD_STATE: BotThreadState = {
  chat_id: null,
  unread: false,
  busy: false,
  pinned: false,
  last_activity_at: null,
  last_message: null,
};

export class BotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotValidationError';
  }
}

export class BotNotFoundError extends Error {
  constructor(message = 'Bot not found') {
    super(message);
    this.name = 'BotNotFoundError';
  }
}

export class BotForbiddenError extends Error {
  constructor(message = 'You cannot change this bot') {
    super(message);
    this.name = 'BotForbiddenError';
  }
}

/** A message handed to a bot, answered in the background in the user's thread with it. */
export interface BotMessageJob {
  userId: string;
  origin: BotTurnOrigin;
  toBotId: string;
  text: string;
  /** For a `bot_mention`: the request the answering job closes (`BotRequestService`). */
  requestId?: string;
}


/** What the workspace service provides; injected so tests need no DB. */
export interface BotWorkspaceDeps {
  getCopilotAgent(): Promise<CopilotAgentType>;
  /** Queue the background turn that answers a message handed to a bot. */
  dispatchBotMessage?(job: BotMessageJob): Promise<unknown>;
  /** The user's name and email: their primary bot is named after them. */
  getUser?(userId: string): Promise<{ name?: string | null; email?: string | null } | null>;
  /**
   * Post `text` as the bot's first message in the user's thread with it (the
   * new bot's greeting), leaving the thread unread.
   */
  greet?(input: { userId: string; bot: BotRow; text: string }): Promise<unknown>;
  /**
   * Tell the open tabs a bot was created, changed, archived or re-pinned, so
   * they re-read the list: `userId` when only that user sees the change (a
   * private bot, their pins), null when everyone does (a shared bot).
   */
  publishBotsChanged?(userId: string | null): Promise<unknown>;
  /**
   * Record the requests a reply's @mentions make, so the asking bot hears
   * back (`BotRequestService.open`). Returns one row per target, in order.
   */
  openRequests?(input: {
    userId: string;
    fromBot: { id: string; name: string };
    fromChatId: string;
    groupId: string;
    targets: { id: string; name: string }[];
    ask: string;
  }): Promise<{ id: string; to_bot_id: string }[]>;
}

/**
 * What a bot is configured by. A new bot needs a name and a look (colour and
 * shape); it has every skill, runs on the workspace's Copilot flavour, and its
 * persona starts blank. Edits change the name, look, sharing and persona.
 */
export interface BotInput {
  name?: unknown;
  /** The persona: the owner's instructions to the bot (markdown). */
  persona_md?: unknown;
  /** Deprecated alias of `persona_md`, accepted for one release. */
  system_prompt?: unknown;
  avatar?: unknown;
  visibility?: unknown;
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new BotValidationError('Name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length > BOT_NAME_MAX_LENGTH) {
    throw new BotValidationError(`Name must be at most ${BOT_NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

/** The persona text; a legacy managed block in the input is dropped. */
function validatePersona(persona: unknown): string {
  if (persona === undefined || persona === null) return '';
  if (typeof persona !== 'string') throw new BotValidationError('Persona must be text');
  const text = personaText(persona);
  if (text.length > BOT_PERSONA_MAX_LENGTH) {
    throw new BotValidationError(`Persona must be at most ${BOT_PERSONA_MAX_LENGTH} characters`);
  }
  return text;
}

/** `persona_md`, or the deprecated `system_prompt` when only that was sent. */
function personaInput(input: BotInput): unknown {
  return input.persona_md !== undefined ? input.persona_md : input.system_prompt;
}

function validateAvatar(avatar: unknown): Required<BotAvatarConfig> {
  if (avatar === undefined || avatar === null) return { ...DEFAULT_BOT_AVATAR };
  if (typeof avatar !== 'object' || Array.isArray(avatar)) {
    throw new BotValidationError('Avatar must be an object');
  }
  const resolved = resolveBotAvatar(avatar as BotAvatarConfig);
  if (resolved.shape === 'apex') throw new BotValidationError('That look is reserved for your primary bot');
  return resolved;
}

function validateVisibility(visibility: unknown) {
  if (visibility === undefined || visibility === null) return 'private' as const;
  if (!isBotVisibility(visibility)) throw new BotValidationError('Visibility must be private or workspace');
  return visibility;
}

/**
 * Whether the user may edit a bot they can see: their own and any shared bot.
 * Brain Bot (the default bot) is never edited.
 */
export function canEditBot(row: Pick<BotRow, 'owner_user_id' | 'visibility' | 'is_default'>, userId: string): boolean {
  if (row.is_default) return false;
  return row.owner_user_id === userId || row.visibility === 'workspace';
}

/**
 * The bot as the app runs it for one user. The primary bot (the workspace's
 * `is_default` row) always has their name for it (`primaryBotName`: "Nico's
 * bot") and its fixed look and persona, whatever the row holds.
 */
export function presentBotRow<T extends BotRow>(row: T, primaryName: string = BRAIN_BOT_NAME): T {
  if (!row.is_default) return row;
  return { ...row, name: primaryName, avatar: { ...BRAIN_BOT_AVATAR }, persona_md: BRAIN_BOT_PERSONA };
}

/**
 * Copilot bots (RFC 02): create, list, edit and archive bots, and open a
 * user's permanent thread with one. Any workspace member may create a bot.
 * A private bot is its owner's alone. A shared bot can be edited by anyone in
 * the workspace; only its owner archives it or changes who sees it.
 *
 * Brain Bot is the workspace default bot (no owner): every member has it,
 * each in their own thread. It is fixed — never edited, archived, pinned or
 * unpinned — and leads every list (`presentBotRow`).
 *
 * Every bot has every skill. A new bot is just a name and a look; its persona
 * (`@/lib/bots/persona`) starts blank and it greets its creator asking who it
 * is, so it is set up through the chat. What every bot is told about its
 * tools is fixed, in `@/lib/bots/prompt`.
 */
export class BotService {
  constructor(
    private readonly botRepo: BotRepository,
    private readonly chatsRepo: CopilotChatsRepository,
    private readonly workspace: BotWorkspaceDeps,
  ) {}

  /** The user's visible bots, creating Brain Bot if the workspace has none. */
  async list(userId: string): Promise<BotDto[]> {
    let rows: VisibleBotRow[] = await this.presentAll(userId, await this.botRepo.listVisible(userId));
    if (!rows.some((b) => b.is_default)) {
      const created = await this.ensureDefault();
      if (created) {
        const [primary] = await this.presentAll(userId, [{ ...created, ...NO_THREAD_STATE }]);
        rows = [primary, ...rows.filter((r) => r.id !== created.id)];
      }
    }
    return rows.map((row) => this.toDto(row, userId, row));
  }

  async get(userId: string, id: string): Promise<BotDto> {
    const row = await this.findVisible(userId, id);
    return this.toDto(row, userId);
  }

  /** Whose bot lists a change to `row` moves: the owner's, or everyone's. */
  private async announceChange(row: Pick<BotRow, 'owner_user_id' | 'visibility' | 'is_default'>, userId: string) {
    const everyone = row.is_default || row.visibility === 'workspace';
    await this.workspace
      .publishBotsChanged?.(everyone ? null : (row.owner_user_id ?? userId))
      ?.catch?.((err: unknown) => console.error('[bots] failed to announce a bot change:', err));
  }

  /**
   * A new bot, on the workspace's Copilot flavour. One with a blank persona
   * (the usual case) greets its creator in their thread with it, asking who
   * it is (`botGreeting`); a failed greeting is logged, the bot stands.
   */
  async create(userId: string, input: BotInput): Promise<BotDto> {
    const fields = this.validateNew(input);
    const row = await this.botRepo.create({
      owner_user_id: userId,
      name: fields.name,
      persona_md: fields.persona_md,
      base_flavor: await this.workspace.getCopilotAgent(),
      avatar: fields.avatar,
      visibility: fields.visibility,
      is_default: false,
    });
    const greet = this.workspace.greet;
    if (!fields.persona_md && greet) {
      await Promise.resolve()
        .then(() => greet({ userId, bot: row, text: botGreeting(row.name) }))
        .catch((err: unknown) => console.error(`[bots] failed to post ${row.id}'s greeting:`, err));
    }
    await this.announceChange(row, userId);
    return this.toDto(row, userId);
  }

  async update(userId: string, id: string, input: BotInput): Promise<BotDto> {
    const row = await this.findVisible(userId, id);
    this.assertCanEdit(userId, row);
    const { patch, after } = this.validatePatch(row, input, userId);
    if (Object.keys(patch).length === 0) return this.toDto(row, userId);
    patch.persona_md = after.persona_md;

    const updated = await this.botRepo.update(id, patch);
    if (!updated) throw new BotNotFoundError();
    // A bot going private leaves everyone else's list: announce to all when
    // either side of the change was shared.
    await this.announceChange(
      { ...updated, visibility: row.visibility === 'workspace' ? 'workspace' : updated.visibility },
      userId,
    );
    return this.toDto(updated, userId);
  }

  /**
   * What `create` would make, validated but not written: for a bot tool's
   * approval card. Throws the same validation errors `create` would.
   */
  previewCreate(input: BotInput): BotChangeFields {
    return this.validateNew(input);
  }

  /**
   * The bot as it is and as `update` would leave it, validated and
   * permission-checked but not written: for a bot tool's approval card. Throws
   * `BotNotFoundError` / `BotForbiddenError` for a bot the user cannot edit.
   */
  async previewUpdate(
    userId: string,
    id: string,
    input: BotInput,
  ): Promise<{ before: BotChangeFields; after: BotChangeFields; changed: (keyof BotChangeFields)[] }> {
    const row = await this.findVisible(userId, id);
    this.assertCanEdit(userId, row);
    const { patch, after } = this.validatePatch(row, input, userId);
    const before = this.fieldsOf(row);
    const changed = (Object.keys(after) as (keyof BotChangeFields)[]).filter(
      (k) => k in patch || (k === 'persona_md' && personaInput(input) !== undefined),
    );
    return { before, after, changed: changed.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])) };
  }

  async archive(userId: string, id: string): Promise<void> {
    const row = await this.findVisible(userId, id);
    if (row.is_default) throw new BotForbiddenError('Your primary bot cannot be archived');
    if (row.owner_user_id !== userId) throw new BotForbiddenError('Only the bot\'s owner can archive it');
    const archived = await this.botRepo.archive(id);
    if (!archived) throw new BotNotFoundError();
    await this.announceChange(row, userId);
  }

  /**
   * The user's one permanent thread with this bot, created on first open,
   * along with the bot itself (the chat route needs both, from one bot read).
   */
  async openThread(userId: string, id: string): Promise<{ bot: BotRow; chat: CopilotChatRow }> {
    const { bot, chat } = await this.openThreadWith(userId, await this.visibleRow(userId, id));
    const greet = this.workspace.greet;
    if (
      greet &&
      !personaText(bot.persona_md) &&
      !chat.last_message_at &&
      !chat.history_imported_at
    ) {
      await greet({ userId, bot, text: botGreeting(bot.name) }).catch((err: unknown) =>
        console.error(`[bots] failed to post ${bot.id}'s greeting on open:`, err),
      );
    }
    return { bot, chat };
  }

  /**
   * The user's thread with Brain Bot, creating the bot if the workspace has
   * none yet. A chat turn that names no bot runs here.
   */
  async openDefaultThread(userId: string): Promise<{ bot: BotRow; chat: CopilotChatRow }> {
    const found = (await this.botRepo.findDefault()) ?? (await this.ensureDefault());
    if (!found) throw new BotNotFoundError();
    return this.openThreadWith(userId, found);
  }

  /**
   * `row` as the app runs it, and the user's thread with it. The two reads
   * behind that — the user's name, which titles their primary bot, and the
   * thread — do not depend on each other, so they are in flight together:
   * this is on every chat turn's critical path, and they used to be one round
   * trip after the other. The thread is created, titled with the presented
   * name, only when the find comes back empty — its first open.
   */
  private async openThreadWith<T extends BotRow>(
    userId: string,
    row: T,
  ): Promise<{ bot: T; chat: CopilotChatRow }> {
    const [[bot], existing] = await Promise.all([
      this.presentAll(userId, [row]),
      this.chatsRepo.findBotThread(userId, row.id),
    ]);
    const chat = existing ?? (await this.chatsRepo.findOrCreateBotThread(userId, bot.id, bot.name));
    return { bot, chat };
  }

  /**
   * Hand a turn's @mentions on: every bot the user's message mentions gets
   * that message, and every bot the reply mentions gets the reply. Each
   * answers in the background, in the user's thread with it. Only bots the
   * user can see, never the bot itself. A user's @mention always pings — every
   * bot it names, uncapped; a reply pings at most `MAX_MENTION_PINGS`, and
   * never a bot in `alreadyPinged` (the ones the user's message pinged).
   * Returns the ids of the bots pinged.
   *
   * Callers pass `userText` only for a message the user typed — as soon as
   * it arrives, so the ping does not depend on the reply — and `replyText`
   * only for a turn that may hand work on: a reply to a mention never pings
   * anyone, so a chain is one hop deep. A reply's mentions also open a
   * request per bot (`openRequests`, with `chatId` as the asker's thread and
   * `turnId` as the group), so each answer comes back to the asker; a failed
   * open is logged and the bots are still pinged.
   */
  async dispatchMentions(
    userId: string,
    input: {
      bot: { id: string; name: string };
      userText?: string;
      replyText?: string;
      alreadyPinged?: readonly string[];
      /** The asking bot's thread with the user (a reply's mentions). */
      chatId?: string;
      /** The asking turn; the group every request it makes shares. */
      turnId?: string;
    },
  ): Promise<string[]> {
    const dispatch = this.workspace.dispatchBotMessage;
    const { bot } = input;
    const userText = input.userText?.trim() ?? '';
    const replyText = input.replyText?.trim() ?? '';
    if (!dispatch || (!userText.includes('@') && !replyText.includes('@'))) return [];

    const visible = await this.presentAll(userId, await this.botRepo.listVisible(userId));
    const jobs: BotMessageJob[] = [];
    for (const target of findBotMentions(userText, visible, { excludeId: bot.id, limit: Infinity })) {
      jobs.push({ userId, origin: { kind: 'user_mention', inBot: bot }, toBotId: target.id, text: userText });
    }
    const asked: { id: string; name: string }[] = [];
    for (const target of findBotMentions(replyText, visible, { excludeId: bot.id })) {
      if (jobs.some((j) => j.toBotId === target.id) || input.alreadyPinged?.includes(target.id)) continue;
      asked.push({ id: target.id, name: target.name });
      jobs.push({ userId, origin: { kind: 'bot_mention', fromBot: bot }, toBotId: target.id, text: replyText });
    }
    if (asked.length > 0 && input.chatId && this.workspace.openRequests) {
      try {
        const rows = await this.workspace.openRequests({
          userId,
          fromBot: bot,
          fromChatId: input.chatId,
          groupId: input.turnId ?? randomUUID(),
          targets: asked,
          ask: replyText,
        });
        for (const row of rows) {
          const job = jobs.find((j) => j.origin.kind === 'bot_mention' && j.toBotId === row.to_bot_id);
          if (job) job.requestId = row.id;
        }
      } catch (err) {
        console.error('[bots] failed to record the requests behind a reply\'s @mentions:', err);
      }
    }
    const results = await Promise.allSettled(jobs.map((job) => dispatch(job)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[bots] failed to hand an @mention to ${jobs[i].toBotId}:`, r.reason);
      }
    });
    return jobs.filter((_, i) => results[i].status === 'fulfilled').map((j) => j.toBotId);
  }

  /** The per-turn note naming the other bots this one can @mention. */
  async mentionContext(userId: string, botId: string): Promise<string> {
    return this.prepareMentionContext(userId)(botId);
  }

  /**
   * `mentionContext` in two steps: the bot list is read now, the note is
   * built once the answering bot is known. The chat route calls this before
   * it opens the thread, so the list — the heaviest of its per-turn reads —
   * is in flight behind the open instead of after it. A failed read surfaces
   * when the note is asked for, never as an unhandled rejection before then.
   */
  prepareMentionContext(userId: string): (botId: string) => Promise<string> {
    const rows = this.botRepo.listVisible(userId).then((visible) => this.presentAll(userId, visible));
    rows.catch(() => undefined);
    return async (botId) => mentionableBotsContext(await rows, botId);
  }

  /**
   * Save the user's pinned bots, in order. Pinned bots lead every bot list
   * (the Copilot strip, the sidebar, the Bots page); the rest follow by newest
   * activity. Ids the user cannot see are dropped. Returns the list in its
   * new order.
   */
  async setPinned(userId: string, botIds: unknown): Promise<BotDto[]> {
    if (!Array.isArray(botIds) || botIds.some((id) => typeof id !== 'string')) {
      throw new BotValidationError('Pinned bots must be a list of bot ids');
    }
    if (botIds.length > BOT_ORDER_MAX_LENGTH) {
      throw new BotValidationError(`At most ${BOT_ORDER_MAX_LENGTH} bots can be pinned`);
    }
    // Brain Bot always leads; it is never in the pin list.
    const visible = new Set(
      (await this.botRepo.listVisible(userId)).filter((b) => !b.is_default).map((b) => b.id),
    );
    const pinned = [...new Set(botIds as string[])].filter((id) => visible.has(id));
    await this.botRepo.savePinned(userId, pinned);
    await this.workspace
      .publishBotsChanged?.(userId)
      ?.catch?.((err: unknown) => console.error('[bots] failed to announce a pin change:', err));
    return this.list(userId);
  }

  /** The user has read their thread with this bot: clears its unread dot. */
  async markRead(userId: string, id: string): Promise<void> {
    const { chat } = await this.openThread(userId, id);
    await this.chatsRepo.markRead(chat.id);
  }

  /** Mark the user's thread with the bot unread again (the mobile swipe). */
  async markUnread(userId: string, id: string): Promise<void> {
    const { chat } = await this.openThread(userId, id);
    await this.chatsRepo.markUnread(chat.id);
  }

  private async findVisible(userId: string, id: string): Promise<BotRow> {
    const [bot] = await this.presentAll(userId, [await this.visibleRow(userId, id)]);
    return bot;
  }

  /** The bot's row as stored, if the user may see it (`findVisible` before presentation). */
  private async visibleRow(userId: string, id: string): Promise<BotRow> {
    const row = await this.botRepo.findById(id);
    if (!row) throw new BotNotFoundError();
    if (!row.is_default && row.visibility !== 'workspace' && row.owner_user_id !== userId) {
      // A private bot owned by someone else is indistinguishable from a missing one.
      throw new BotNotFoundError();
    }
    return row;
  }

  /**
   * `rows` as the app runs them for this user (`presentBotRow`). Reads the
   * user's name once, and only when the primary bot is among them.
   */
  private async presentAll<T extends BotRow>(userId: string, rows: T[]): Promise<T[]> {
    if (!rows.some((r) => r.is_default)) return rows;
    const name = await this.primaryNameFor(userId);
    return rows.map((r) => presentBotRow(r, name));
  }

  /**
   * The read in flight, not its result: two presentations started together
   * (the chat route reads the bot list while it opens the thread) share one
   * user read instead of each missing the cache.
   */
  private readonly primaryNames = new Map<string, Promise<string>>();

  private primaryNameFor(userId: string): Promise<string> {
    const cached = this.primaryNames.get(userId);
    if (cached) return cached;
    const name = Promise.resolve(this.workspace.getUser?.(userId))
      .catch((err: unknown) => {
        console.error('[bots] failed to read the user for their primary bot name:', err);
        return null;
      })
      .then((user) => primaryBotName(user));
    this.primaryNames.set(userId, name);
    return name;
  }

  /** A bot the user can see, as its row: for the services built on bots (routines, the task log). */
  async findVisibleRow(userId: string, id: string): Promise<BotRow> {
    return this.findVisible(userId, id);
  }

  /** Throws unless the user may edit this (visible) bot. */
  assertCanEdit(userId: string, row: BotRow): void {
    if (row.is_default) throw new BotForbiddenError('The primary bot cannot be changed');
    if (!canEditBot(row, userId)) throw new BotForbiddenError();
  }

  private validateNew(input: BotInput): BotChangeFields {
    return {
      name: validateName(input.name),
      persona_md: validatePersona(personaInput(input)),
      avatar: validateAvatar(input.avatar),
      visibility: validateVisibility(input.visibility),
    };
  }

  /** The patch an update writes (persona excluded), and the bot after it. */
  private validatePatch(
    row: BotRow,
    input: BotInput,
    userId: string,
  ): { patch: BotPatch; after: BotChangeFields } {
    const patch: BotPatch = {};
    if (input.name !== undefined) patch.name = validateName(input.name);
    if (input.avatar !== undefined) patch.avatar = validateAvatar(input.avatar);
    if (input.visibility !== undefined) {
      const visibility = validateVisibility(input.visibility);
      if (visibility !== row.visibility) {
        if (row.is_default) throw new BotValidationError('The primary bot cannot be changed');
        if (row.owner_user_id !== userId) {
          throw new BotForbiddenError('Only the bot\'s owner can change who sees it');
        }
        patch.visibility = visibility;
      }
    }
    const persona = personaInput(input);
    const current = this.fieldsOf(row);
    const after: BotChangeFields = {
      name: patch.name ?? current.name,
      avatar: patch.avatar ? resolveBotAvatar(patch.avatar) : current.avatar,
      visibility: (patch.visibility as BotVisibility | undefined) ?? current.visibility,
      persona_md: persona !== undefined ? validatePersona(persona) : current.persona_md,
    };
    // The persona is re-rendered by the caller; mark it as changed so an
    // update that only edits the persona still writes.
    if (persona !== undefined) patch.persona_md = after.persona_md;
    return { patch, after };
  }

  /** A row's editable fields. */
  private fieldsOf(row: BotRow): BotChangeFields {
    return {
      name: row.name,
      persona_md: personaText(row.persona_md || row.system_prompt),
      avatar: resolveBotAvatar(row.avatar),
      visibility: isBotVisibility(row.visibility) ? row.visibility : 'private',
    };
  }

  private async ensureDefault(): Promise<BotRow | null> {
    const fields: BotChangeFields = {
      name: BRAIN_BOT_NAME,
      persona_md: BRAIN_BOT_PERSONA,
      avatar: { ...BRAIN_BOT_AVATAR },
      // Every member reaches it; each in their own thread, so it is not "shared".
      visibility: 'workspace',
    };
    return this.botRepo.ensureDefault({
      name: fields.name,
      persona_md: fields.persona_md,
      base_flavor: await this.workspace.getCopilotAgent(),
      avatar: fields.avatar,
      visibility: fields.visibility,
    });
  }

  private toDto(
    row: BotRow,
    userId: string,
    state: BotThreadState = NO_THREAD_STATE,
  ): BotDto {
    const fields = this.fieldsOf(row);
    return {
      id: row.id,
      name: row.name,
      persona_md: fields.persona_md,
      avatar: fields.avatar,
      visibility: fields.visibility,
      is_default: row.is_default,
      owner_user_id: row.owner_user_id,
      can_edit: canEditBot(row, userId),
      is_owner: row.owner_user_id !== null && row.owner_user_id === userId,
      thread_id: state.chat_id ?? null,
      unread: state.unread,
      busy: state.busy,
      pinned: row.is_default ? false : state.pinned,
      last_activity_at: state.last_activity_at,
      last_message: state.last_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
