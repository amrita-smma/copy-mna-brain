import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { encodeApprovalMarker } from '@/lib/insights/approvalMarker';
import {
  OPTION_CARD_MARKER,
  OPTION_CARD_MAX_OPTIONS,
  OPTION_CARD_MIN_OPTIONS,
  OptionCardValidationError,
  buildOptionCard,
} from '@/lib/chat/optionCards';
import { logger } from '../../logger';

const argsSchema = z.object({
  question: z.string().min(1).describe('The question, short and specific, e.g. "Which markets should the screen cover?"'),
  mode: z
    .enum(['single', 'multi'])
    .optional()
    .describe('single (default): the user picks one, sent on click. multi: the user ticks any number, then sends.'),
  options: z
    .array(
      z.object({
        label: z.string().min(1).describe('The choice as the user would say it, a few words.'),
        description: z.string().optional().describe('Optional: one short line on what picking it means.'),
        recommended: z.boolean().optional().describe('Mark your own pick (at most one).'),
      }),
    )
    .min(OPTION_CARD_MIN_OPTIONS)
    .max(OPTION_CARD_MAX_OPTIONS)
    .describe(`${OPTION_CARD_MIN_OPTIONS}–${OPTION_CARD_MAX_OPTIONS} distinct options.`),
  allow_custom: z
    .boolean()
    .optional()
    .describe('Let the user type their own answer (default true). Turn off only when the options are exhaustive.'),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Show the user clickable choices (an option card) instead of listing options
 * in prose. Writes nothing: the card renders in the transcript and the user's
 * pick comes back as their next message. Withheld from background turns —
 * nobody is there to click.
 */
export const offerOptions = tool(
  async (args: Args) => {
    logger.debug(`🔧 TOOL CALLED: offer_options(question='${args.question}')`);
    try {
      const card = buildOptionCard({
        card_id: randomUUID(),
        question: args.question ?? '',
        mode: args.mode,
        options: (args.options ?? []).map((o) => ({
          label: o.label ?? '',
          description: o.description,
          recommended: o.recommended,
        })),
        allow_custom: args.allow_custom,
      });
      return [
        `Showed the user ${card.mode === 'multi' ? 'a multiple-choice' : 'a single-choice'} card: "${card.question}" (${card.options.map((o) => o.label).join(' / ')}${card.allow_custom ? ' / their own answer' : ''}).`,
        'End your reply now with at most one short line; their pick arrives as their next message.',
        '',
        encodeApprovalMarker(OPTION_CARD_MARKER, card),
      ].join('\n');
    } catch (error) {
      if (error instanceof OptionCardValidationError) return `Rejection: ${error.message}`;
      logger.error(`offer_options error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'offer_options',
    description:
      'Ask the user to choose, as clickable option cards, instead of listing choices in prose. Use it when the next step genuinely depends on the user — a direction, a scope, which of several matching companies, which deliverable — not for questions you can settle with your tools. single for one pick, multi when several can apply; keep allow_custom on unless the list is exhaustive. After calling it, stop: say at most one short line, and continue when their answer arrives.',
    schema: argsSchema,
  },
);
