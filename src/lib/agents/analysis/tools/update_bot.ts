import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import {
  BotForbiddenError,
  BotNotFoundError,
  BotValidationError,
} from '@/lib/services/botService';
import { encodeApprovalMarker } from '@/lib/insights/approvalMarker';
import {
  BOT_CHANGE_APPROVAL_MARKER,
  type BotChangeApprovalPayload,
  type BotChangeFields,
} from '@/lib/bots/approval';
import { BOT_MEMORY_NOTE_MAX_LENGTH, type BotMemoryNote } from '@/lib/bots/memoryTypes';
import { personaText } from '@/lib/bots/persona';
import {
  NO_USER_CONTEXT_ERROR,
  botNameList,
  readBotToolContext,
  resolveBotRef,
} from '@/lib/bots/toolContext';
import { botLookArgs, lookFromArgs } from './botChangeArgs';
import { logger } from '../../logger';

/** Notes one call may remember or forget: a request is a few, not a dump. */
export const MAX_NOTES_PER_CALL = 10;

const argsSchema = z.object({
  bot: z
    .string()
    .min(1)
    .optional()
    .describe('The bot to change: its name or id (see lookup_bot). Omit to change yourself.'),
  persona: z
    .string()
    .optional()
    .describe(
      "PERSONA (everyone): replace the bot's persona — its instructions to itself, in markdown: purpose, focus, how to answer — with this text. Changes how the bot behaves for every user.",
    ),
  persona_append: z
    .string()
    .optional()
    .describe('PERSONA (everyone): add this text to the end of the persona instead of replacing it.'),
  remember: z
    .array(z.string().min(1).max(BOT_MEMORY_NOTE_MAX_LENGTH))
    .max(MAX_NOTES_PER_CALL)
    .optional()
    .describe(
      'MEMORY (this user only): notes to keep about the person chatting — their preferences and standing requests for this bot, one per entry, in their terms ("Remind me about stalled deals on Fridays", "Answer in Bahasa", "I cover Indonesian mining"). Saved at once, seen only by this user, never changes the bot for anyone else.',
    ),
  forget: z
    .array(z.string().min(1))
    .max(MAX_NOTES_PER_CALL)
    .optional()
    .describe('MEMORY (this user only): notes to drop, each by its words as it was saved (see the context block for the exact notes).'),
  name: z.string().optional().describe('A new name. Applies at once on a private bot; a shared bot\'s goes on a confirmation card.'),
  shared: z
    .boolean()
    .optional()
    .describe('Share with the workspace (true) or make private (false). Sharing or unsharing always goes on a confirmation card, since everyone gains or loses the bot.'),
  ...botLookArgs,
});

type Args = z.infer<typeof argsSchema>;

const quoteAll = (notes: readonly BotMemoryNote[]) => notes.map((n) => `"${n.text}"`).join('; ');

/** One changed field in words, for the tool's reply and the card's warning. */
function describeChange(field: keyof BotChangeFields, after: BotChangeFields): string {
  switch (field) {
    case 'persona_md':
      return 'persona';
    case 'avatar':
      return 'look';
    case 'name':
      return `name → "${after.name}"`;
    case 'visibility':
      return after.visibility === 'workspace' ? 'shared with the workspace' : 'made private';
  }
}
const quoteTexts = (texts: readonly string[]) => texts.map((t) => `"${t}"`).join('; ');

/**
 * Change a bot, or what it remembers about this user — two different things
 * the tool keeps apart. The persona is the bot's behaviour for everyone: on a
 * private bot it is written at once; on a shared bot it goes on a card with a
 * warning, because it changes the bot for the whole workspace. Memory is this
 * user's notes on the bot: written at once, theirs alone, on any bot they can
 * see. Name, look and sharing follow the persona's rule: written at once on
 * a private bot, confirmed on a card with a warning when the bot is shared —
 * or becomes shared, or stops being shared, with this call. The API checks
 * permissions again for anything a card applies.
 */
export const updateBot = tool(
  async (args: Args, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: update_bot(bot='${args.bot ?? 'self'}')`);
    const ctx = readBotToolContext(config);
    if (!ctx) return NO_USER_CONTEXT_ERROR;
    if (args.persona !== undefined && args.persona_append !== undefined) {
      return 'Rejection: pass either persona (replace) or persona_append (add to the end), not both.';
    }
    const look = lookFromArgs(args);
    if ('error' in look) return `Rejection: ${look.error}`;

    const lines: string[] = [];
    try {
      const { createContainer } = await import('@/lib/services/container');
      const { botService, botMemoryService } = createContainer(createDb(), await getActiveWorkspaceId());
      const bots = await botService.list(ctx.userId);
      const target = args.bot
        ? resolveBotRef(bots, args.bot)
        : ctx.botId
          ? (bots.find((b) => b.id === ctx.botId) ?? null)
          : null;
      if (!target) {
        return args.bot
          ? `Rejection: no single bot matches "${args.bot}". The bots are: ${botNameList(bots)}.`
          : 'Rejection: name the bot to change (bot: its name), or run this from a bot chat to change yourself.';
      }

      // Memory first: the user's own notes, on any bot they can see.
      if (args.remember?.length) {
        const { added, skipped } = await botMemoryService.remember(ctx.userId, target.id, args.remember);
        if (added.length > 0) lines.push(`Remembered for this user on **${target.name}**: ${quoteAll(added)}.`);
        if (skipped.length > 0) lines.push(`Already noted on **${target.name}**: ${quoteTexts(skipped)}.`);
      }
      if (args.forget?.length) {
        const { removed, missing } = await botMemoryService.forget(ctx.userId, target.id, args.forget);
        if (removed.length > 0) lines.push(`Forgot on **${target.name}**: ${quoteAll(removed)}.`);
        if (missing.length > 0) lines.push(`No note on **${target.name}** about: ${quoteTexts(missing)}.`);
      }

      // Then the bot itself.
      const input: Record<string, unknown> = {};
      if (args.name !== undefined) input.name = args.name;
      if (args.shared !== undefined) input.visibility = args.shared ? 'workspace' : 'private';
      if (Object.keys(look.avatar).length > 0) input.avatar = { ...target.avatar, ...look.avatar };
      if (args.persona !== undefined) input.persona_md = args.persona;
      if (args.persona_append !== undefined) {
        input.persona_md = [personaText(target.persona_md), args.persona_append.trim()].filter(Boolean).join('\n\n');
      }
      if (Object.keys(input).length === 0) {
        return lines.length > 0
          ? lines.join('\n')
          : 'Nothing to change: pass a persona, a name, a look or sharing, or notes to remember or forget.';
      }
      if (!target.can_edit) {
        lines.push(
          `Rejection: the user cannot edit **${target.name}**${target.is_default ? ' (the primary bot is fixed: nobody can change it)' : ' (only its owner can)'}.`,
        );
        return lines.join('\n');
      }

      const { before, after, changed } = await botService.previewUpdate(ctx.userId, target.id, input);
      if (changed.length === 0) {
        lines.push(`Nothing to change on **${target.name}**: it already looks like that.`);
        return lines.join('\n');
      }

      // Shared on either side of the change: a bot that is shared now, one
      // this call shares (a persona set in the same call is for everyone
      // too), or one it takes away from everyone by making private.
      const shared = before.visibility === 'workspace' || after.visibility === 'workspace';
      const change = Object.fromEntries(changed.map((k) => [k, after[k]])) as Partial<BotChangeFields>;
      const described = changed.map((k) => describeChange(k, after)).join(', ');
      if (!shared) {
        // A private bot is its owner's to change: no card.
        await botService.update(ctx.userId, target.id, change);
        lines.push(`Updated **${target.name}** (${described}); it applies from its next reply.`);
        return lines.join('\n');
      }

      const payload: BotChangeApprovalPayload = {
        approval_id: randomUUID(),
        action: 'update',
        bot_id: target.id,
        before,
        after,
        input: change,
        warning:
          before.visibility === 'workspace'
            ? `${target.name} is shared with the workspace: this changes it for everyone who uses it (${described}), not just for you. Confirm to apply the change below.`
            : `${target.name} will be shared with the workspace: everyone gets it as it is below (${described}), not just you. Confirm to share it.`,
      };
      lines.push(
        `Proposed a change to **${target.name}** (${described}) for the user to confirm on a card, because the bot ${before.visibility === 'workspace' ? 'is' : 'would become'} shared. Nothing changes until they do.`,
      );
      return [...lines, '', encodeApprovalMarker(BOT_CHANGE_APPROVAL_MARKER, payload)].join('\n');
    } catch (error) {
      if (
        error instanceof BotValidationError ||
        error instanceof BotForbiddenError ||
        error instanceof BotNotFoundError
      ) {
        return [...lines, `Rejection: ${error.message}`].join('\n');
      }
      logger.error(`update_bot error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'update_bot',
    description: [
      'Change a Copilot bot, or what it remembers about the person chatting. Two different things — pick the right one:',
      '• persona / persona_append — how the bot behaves for EVERYONE who uses it: its purpose, focus, tone, rules of thumb ("be more concise", "focus on Indonesian mining", "you are our CRM assistant"). On a private bot it applies at once; on a shared bot the user confirms it on a card, because it changes the bot for the whole workspace.',
      '• remember / forget — what is particular to THIS USER: their preferences and standing requests for the bot ("remember that I cover coal", "remind me about stalled deals on Fridays", "answer me in Bahasa", "call me Nico", "use this bot to remind me about X"). Saved at once, seen only by this user, never changes the bot for anyone else. When the request is about the person, or starts with "remember" or "for me", it is memory.',
      '• name / colour / shape / shared — the bot itself. Like the persona: at once on a private bot; confirmed on a card when the bot is shared, or would become shared or private with this call (so sharing or unsharing always goes on the card).',
      'Omit bot to change yourself. Only bots the user may edit can be changed; notes are the user\'s own on any bot they can see.',
    ].join('\n'),
    schema: argsSchema,
  },
);
