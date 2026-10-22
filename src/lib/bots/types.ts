/**
 * Client-safe vocabulary for Copilot bots (RFC 02). Imports nothing from the
 * agent stack, so views, routes and services can use it without pulling
 * LangChain into their bundle. Tool resolution lives in `./skills`.
 */
import type { BotAvatarConfig } from '@/lib/db/schema';

export type { BotAvatarConfig };

export const BOT_VISIBILITIES = ['private', 'workspace'] as const;
export type BotVisibility = (typeof BOT_VISIBILITIES)[number];

export const BOT_EYE_STYLES = ['round', 'sleepy', 'sparkle', 'mono'] as const;
export type BotEyeStyle = (typeof BOT_EYE_STYLES)[number];

export const BOT_MOODS = ['cheerful', 'calm', 'curious'] as const;
export type BotMood = (typeof BOT_MOODS)[number];

/** Body designs. Every one wears a dark visor with glowing eyes. */
export const BOT_SHAPES = ['nova', 'hexa', 'nimbo', 'orbit', 'pixel'] as const;
export type BotShape = (typeof BOT_SHAPES)[number];

/** What each body is called and reads as, for the editor and the persona. */
export const BOT_SHAPE_META: Record<BotShape, { label: string; tagline: string }> = {
  nova: { label: 'Nova', tagline: 'Clean, friendly, versatile' },
  hexa: { label: 'Hexa', tagline: 'Modular, modern, distinctive' },
  nimbo: { label: 'Nimbo', tagline: 'Soft, approachable, calm' },
  orbit: { label: 'Orbit', tagline: 'Dynamic, intelligent, playful' },
  pixel: { label: 'Pixel', tagline: 'Sharp, geometric, bold' },
};

/**
 * Every body the avatar draws: the pickable ones, plus `apex`, Brain Bot's
 * own black body, which no other bot may wear.
 */
export const BOT_BODIES = [...BOT_SHAPES, 'apex'] as const;
export type BotBody = (typeof BOT_BODIES)[number];

/**
 * The bodies before the redesign, mapped to their closest new one. Stored
 * avatars were migrated; this covers anything that still carries an old name,
 * such as an approval card in old chat history.
 */
export const LEGACY_BOT_SHAPES: Record<string, BotShape> = {
  robot: 'pixel',
  capsule: 'nova',
  blob: 'nimbo',
  cat: 'orbit',
  ghost: 'hexa',
};

/**
 * The skill catalogue. Every bot has every skill: a skill is just a named set
 * of tools with a guide, written into every bot's fixed instructions. Tools
 * are in `./skills`.
 */
export const BOT_SKILL_KEYS = [
  'crm',
  'pipeline',
  'insights',
  'research',
  'relationships',
  'email',
  'bot_builder',
  'routines',
  'tasks',
] as const;
export type BotSkillKey = (typeof BOT_SKILL_KEYS)[number];

export interface BotSkillMeta {
  key: BotSkillKey;
  label: string;
  /** What the skill is for, in a line (the bot's About tab). */
  description: string;
  /** How the bot should use the skill; written into its fixed instructions. */
  guide: string;
}

export const BOT_SKILL_META: Record<BotSkillKey, BotSkillMeta> = {
  crm: {
    key: 'crm',
    label: 'CRM',
    description: 'Look up firms, bankers, coverage and meeting notes.',
    guide:
      'Use lookup_crm for a firm or banker, crm_insights for relationship health, and query_files for meeting notes. Name the source record when you cite it.',
  },
  pipeline: {
    key: 'pipeline',
    label: 'Pipeline',
    description: 'Search the deal pipeline, stages and stalled deals.',
    guide:
      'Use query_companies and get_company_stats for the deal pipeline, list_pipeline_stages for stage names, and analyze_stalled_deals for deals that have not moved.',
  },
  insights: {
    key: 'insights',
    label: 'Insights',
    description: 'Read insights, propose edits or refreshes, and hand new ones to the Workforce.',
    guide:
      'Read an insight with get_insight. To edit or refresh one, use the propose_insight_* tools so the user approves the change on a card. To create a new insight, hand it to the Workforce with propose_workforce_handoff: it builds the insight section by section and emails the requester a link when it is published.',
  },
  research: {
    key: 'research',
    label: 'Web research',
    description: 'Search and read the web for current facts.',
    guide:
      'Use web_search for current facts and valyu_search for filings and financial diligence. Cite every external fact inline with its source and publication date, linked to its URL.',
  },
  relationships: {
    key: 'relationships',
    label: 'Relationships',
    description: "Read a company's relationship graph.",
    guide: "Use read_relationship_graph to describe a company's shareholders, subsidiaries and counterparties.",
  },
  email: {
    key: 'email',
    label: 'Email',
    description: 'Send an email to you or named platform users.',
    guide:
      'send_email sends one email to the signed-in user or named platform users. Confirm the recipients and content in your reply before you send.',
  },
  bot_builder: {
    key: 'bot_builder',
    label: 'Bot builder',
    description: 'Create bots; change their name, look, sharing and persona; keep notes for the user.',
    guide:
      'Use lookup_bot to see the bots. To create a bot use propose_create_bot (a name, a colour and a shape; optionally a persona and the routines it starts with — without a persona a new bot asks its owner who it is); the user approves it on a card. To change a bot use update_bot: its persona, name or look (applies at once on a private bot; on a shared bot the user confirms it on a card, since it changes the bot for everyone), its sharing (always confirmed on a card), and what it remembers about this user (remember / forget — saved at once, this user\'s alone). You can only change bots the user may edit; notes are the user\'s own on any bot they can see.',
  },
  routines: {
    key: 'routines',
    label: 'Routines',
    description: 'Schedule recurring tasks: a message the bot is sent daily, weekly or monthly; change, pause or delete them.',
    guide:
      'When the user wants something done on a schedule, use list_routines to check for a similar routine, then propose_create_routine: a title, the schedule, and the message you will be sent each time — written as the full task. The user approves it on a card. Each run arrives in this chat as a message from the routine; do the task and answer for the user to read later. Existing routines are yours to manage directly, no card: update_routine to rename one, rewrite its message, move it to another time, day or timezone, or pause / resume it (give only what changes), and delete_routine to remove one for good. Read list_routines first so you name the right one, and tell the user in a few words what you did.',
  },
  tasks: {
    key: 'tasks',
    label: 'Tasks',
    description: "Read, add, change, complete and delete the user's personal to-dos and reminders.",
    guide:
      "The user's personal to-do list is yours to manage directly, no card and no Workforce: list_tasks to read it (it reports the current time, so you can work out \"tomorrow at 9\"), create_task to add one with an optional reminder, update_task to rename, re-time, complete or reopen one, delete_task to remove one for good. Read the list before changing a task so you name the right one, and tell the user in a few words what you did. Only long-running work — building an insight — goes to the Workforce; a to-do never does.",
  },
};

export function isBotVisibility(value: unknown): value is BotVisibility {
  return typeof value === 'string' && (BOT_VISIBILITIES as readonly string[]).includes(value);
}

export const BOT_NAME_MAX_LENGTH = 60;
/** The persona (the bot's system prompt as its owner writes it). */
export const BOT_PERSONA_MAX_LENGTH = 16_000;

/** What a new bot says first, in its creator's chat: it starts with a blank persona. */
export function botGreeting(name: string): string {
  return `Hi there! I'm ${name.trim()}. Tell me who I am and what I do!`;
}

/** Colour words the bot tools accept, as avatar hues. */
export const BOT_COLOR_HUES: Record<string, number> = {
  red: 0,
  orange: 28,
  amber: 40,
  yellow: 52,
  lime: 90,
  green: 140,
  emerald: 155,
  teal: 172,
  cyan: 190,
  sky: 205,
  blue: 222,
  indigo: 245,
  violet: 265,
  purple: 280,
  magenta: 305,
  pink: 330,
  rose: 345,
};

/** A colour word or a 0–359 hue as an avatar hue; null when it is neither. */
export function colorToHue(color: string | number): number | null {
  if (typeof color === 'number') return Number.isFinite(color) ? ((Math.round(color) % 360) + 360) % 360 : null;
  const trimmed = color.trim().toLowerCase();
  if (trimmed in BOT_COLOR_HUES) return BOT_COLOR_HUES[trimmed]!;
  const asNumber = Number(trimmed);
  return trimmed !== '' && Number.isFinite(asNumber) ? colorToHue(asNumber) : null;
}

export const DEFAULT_BOT_AVATAR: Required<BotAvatarConfig> = {
  hue: 222,
  eyes: 'round',
  mood: 'cheerful',
  shape: 'nova',
};

/** A fresh, varied look for a new bot, so a row of bots doesn't read as clones. */
export function randomBotAvatar(random: () => number = Math.random): Required<BotAvatarConfig> {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length) % xs.length]!;
  return {
    hue: Math.floor(random() * 360) % 360,
    eyes: pick(BOT_EYE_STYLES),
    mood: pick(BOT_MOODS),
    shape: pick(BOT_SHAPES),
  };
}

/** The avatar with every field filled, ignoring values this build doesn't know. */
export function resolveBotAvatar(avatar: BotAvatarConfig | null | undefined): Required<BotAvatarConfig> {
  const hue =
    typeof avatar?.hue === 'number' && Number.isFinite(avatar.hue)
      ? ((Math.round(avatar.hue) % 360) + 360) % 360
      : DEFAULT_BOT_AVATAR.hue;
  const eyes = (BOT_EYE_STYLES as readonly string[]).includes(avatar?.eyes ?? '')
    ? (avatar!.eyes as BotEyeStyle)
    : DEFAULT_BOT_AVATAR.eyes;
  const mood = (BOT_MOODS as readonly string[]).includes(avatar?.mood ?? '')
    ? (avatar!.mood as BotMood)
    : DEFAULT_BOT_AVATAR.mood;
  const rawShape: string = avatar?.shape ?? '';
  const shape: BotBody = (BOT_BODIES as readonly string[]).includes(rawShape)
    ? (rawShape as BotBody)
    : (LEGACY_BOT_SHAPES[rawShape] ?? DEFAULT_BOT_AVATAR.shape);
  return { hue, eyes, mood, shape };
}

/**
 * The primary bot (the codebase calls it Brain Bot). Every account has it;
 * it leads every bot list, cannot be pinned, unpinned,
 * edited or archived, and wears the black `apex` body no other bot can. It is
 * the workspace's one `is_default` row, but each user's thread with it (and
 * its routines and task log) is their own, so it is nobody's shared bot — and
 * each user sees it under their own name (`primaryBotName`).
 */
export const BRAIN_BOT_NAME = 'Primary bot';

/**
 * What a user calls their primary bot: their first name's bot ("Nico's bot").
 * The first word of their name, else of their email's local part, else "My
 * bot".
 */
export function primaryBotName(user: { name?: string | null; email?: string | null } | null | undefined): string {
  const fromName = user?.name?.trim().split(/\s+/)[0] ?? '';
  const fromEmail = user?.email?.split('@')[0]?.split(/[._+-]+/).find(Boolean) ?? '';
  const first = (fromName || fromEmail).slice(0, 40);
  if (!first) return 'My bot';
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}'s bot`;
}

export const BRAIN_BOT_AVATAR: Required<BotAvatarConfig> = {
  hue: 28,
  eyes: 'round',
  mood: 'calm',
  shape: 'apex',
};

/** The primary bot's persona: fixed, unlike every other bot's. */
export const BRAIN_BOT_PERSONA = `You are the user's primary agent: always on, with every skill.

- Take on anything the user asks: research, the pipeline, CRM, insights, email, routines and building other bots.
- When another bot is set up for a piece of work, hand it on with an @mention by its exact name, then tell the user who you asked and why.
- Keep the user's goal in view across the whole conversation, and finish the job rather than handing it back.`;

/** A bot as the client sees it. */
export interface BotDto {
  id: string;
  name: string;
  /** The persona: the owner's instructions; blank for a new bot. */
  persona_md: string;
  avatar: Required<BotAvatarConfig>;
  visibility: BotVisibility;
  is_default: boolean;
  owner_user_id: string | null;
  /** Whether the requesting user may edit it: their own bots, shared bots and the default bot. */
  can_edit: boolean;
  /** The requesting user owns it: only the owner archives it or changes who sees it. */
  is_owner: boolean;
  /** The user's thread with this bot, once opened: the key its live state is filed under. */
  thread_id: string | null;
  /** The user's thread with this bot has a reply they have not seen. */
  unread: boolean;
  /** The bot is answering in the user's thread right now (its turn lock is held). */
  busy: boolean;
  /** The user pinned it: pinned bots lead every list, in the user's order. */
  pinned: boolean;
  /** The latest reply in the user's thread with it; unpinned bots sort newest first. */
  last_activity_at: string | null;
  /** The start of the latest message in that thread (mobile list preview). */
  last_message: { role: 'user' | 'assistant'; text: string } | null;
  created_at: string;
  updated_at: string;
}
