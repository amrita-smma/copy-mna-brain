import { z } from 'zod';
import { BOT_SHAPES, colorToHue } from '@/lib/bots/types';

/**
 * The look a bot tool may set on a bot — a colour and a shape, all a bot's
 * look is configured by — shared by propose_create_bot and update_bot.
 */
export const botLookArgs = {
  color: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Colour: a word (red, orange, amber, yellow, lime, green, teal, cyan, sky, blue, indigo, violet, purple, magenta, pink, rose) or a hue 0–359.'),
  shape: z.enum(BOT_SHAPES).optional().describe('Body shape of the avatar.'),
};

export interface BotLookArgs {
  color?: string | number;
  shape?: (typeof BOT_SHAPES)[number];
}

/** The avatar fields the args set, or an error message for an unknown colour. */
export function lookFromArgs(args: BotLookArgs): { avatar: Record<string, unknown> } | { error: string } {
  const avatar: Record<string, unknown> = {};
  if (args.color !== undefined) {
    const hue = colorToHue(args.color);
    if (hue === null) return { error: `Unknown colour "${args.color}". Use a colour word or a hue from 0 to 359.` };
    avatar.hue = hue;
  }
  if (args.shape) avatar.shape = args.shape;
  return { avatar };
}
