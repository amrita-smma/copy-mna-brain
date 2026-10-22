import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { BotValidationError } from '@/lib/services/botService';
import { BotRoutineValidationError } from '@/lib/services/botRoutineService';
import { encodeApprovalMarker } from '@/lib/insights/approvalMarker';
import { BOT_CHANGE_APPROVAL_MARKER, type BotChangeApprovalPayload, type ProposedBotRoutine } from '@/lib/bots/approval';
import { randomBotAvatar } from '@/lib/bots/types';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import { botLookArgs, lookFromArgs } from './botChangeArgs';
import { routineArgsSchema, routineInputFromArgs } from './routineArgs';
import { logger } from '../../logger';

/** Routines one proposal may set up; more is a sign the bot should be split. */
export const MAX_PROPOSED_ROUTINES = 5;

const argsSchema = z.object({
  name: z.string().min(1).describe('The new bot\'s name.'),
  ...botLookArgs,
  persona: z
    .string()
    .optional()
    .describe(
      "The bot's persona — its instructions to itself, in markdown: its purpose, what to focus on, how to answer. Leave out to let the bot ask its owner who it is in its first chat.",
    ),
  routines: z
    .array(routineArgsSchema)
    .max(MAX_PROPOSED_ROUTINES)
    .optional()
    .describe(
      `Routines the bot starts with (at most ${MAX_PROPOSED_ROUTINES}): each a title, the message the bot is sent, and a schedule. They are created with the bot when the user approves.`,
    ),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Propose a new bot on an approval card: a name, a colour and a shape, and
 * optionally the persona and the routines it starts with. It has every skill
 * and starts private; without a persona it greets its owner asking who it is.
 * Nothing is created until the user approves; the card then calls the bots
 * API (and the routines API, per routine), which validate again.
 */
export const proposeCreateBot = tool(
  async (args: Args, config?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: propose_create_bot(name='${args.name}')`);
    const ctx = readBotToolContext(config);
    if (!ctx) return NO_USER_CONTEXT_ERROR;
    const look = lookFromArgs(args);
    if ('error' in look) return `Rejection: ${look.error}`;

    try {
      const { createContainer } = await import('@/lib/services/container');
      const { botService, botRoutineService } = createContainer(createDb(), await getActiveWorkspaceId());
      // Unset look fields get a random value, so a new bot never looks like a
      // clone of the default one.
      const avatar = { ...randomBotAvatar(), ...look.avatar };
      const persona = args.persona?.trim();
      const after = botService.previewCreate({ name: args.name, avatar, ...(persona ? { persona_md: persona } : {}) });
      // Each routine is checked as the routines API will check it; the bot it
      // belongs to does not exist yet, so permission is the card's to settle.
      const routines: ProposedBotRoutine[] = (args.routines ?? []).map((r) => {
        const proposed = routineInputFromArgs(r);
        const { routine, label } = botRoutineService.validateInput({ ...proposed, timezone: proposed.timezone || 'UTC' });
        return { label, input: { ...routine, timezone: proposed.timezone } };
      });
      const payload: BotChangeApprovalPayload = {
        approval_id: randomUUID(),
        action: 'create',
        after,
        input: after,
        ...(routines.length > 0 ? { routines } : {}),
      };
      const summary = [
        `Proposed a new bot **${after.name}**${persona ? ' with a persona' : ''}${
          routines.length > 0 ? ` and ${routines.length} routine${routines.length === 1 ? '' : 's'} (${routines.map((r) => `${r.input.title}: ${r.label}`).join('; ')})` : ''
        } for the user to approve. Nothing is created until they click Create on the card.`,
        persona
          ? 'Once created, it works from that persona in its own chat.'
          : 'Once created, it greets them in its own chat and asks who it is — they set it up there.',
      ].join(' ');
      return [summary, '', encodeApprovalMarker(BOT_CHANGE_APPROVAL_MARKER, payload)].join('\n');
    } catch (error) {
      if (error instanceof BotValidationError || error instanceof BotRoutineValidationError) {
        return `Rejection: ${error.message}`;
      }
      logger.error(`propose_create_bot error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'propose_create_bot',
    description:
      'Propose a new Copilot bot for the user to approve on a card: its name, colour and shape, and optionally its persona (markdown instructions to itself) and the routines it starts with (a title, the message it is sent, a daily/weekly/monthly/cron schedule). Every bot has every skill; a new one is private. Without a persona it asks its owner, in its own chat, who it is and what it does. Colour or shape you leave out is picked at random. Nothing is created until the user approves; routines are created with the bot.',
    schema: argsSchema,
  },
);
