/**
 * The bot-to-bot message as `POST /api/internal/bot-messages` receives it:
 * which workspace, which user, which bot, which text, how it came about, and
 * the request it answers. The same shape as `BotMessageJob` plus the
 * workspace, validated at the route boundary.
 */
import { z } from 'zod';

const botRef = z.object({ id: z.string().min(1), name: z.string() });

export const botTurnOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bot_mention'), fromBot: botRef }),
  z.object({ kind: z.literal('user_mention'), inBot: botRef }),
  z.object({ kind: z.literal('routine'), routine: z.object({ id: z.string().min(1), title: z.string() }) }),
  z.object({
    kind: z.literal('bot_reply'),
    replies: z.array(
      z.object({
        fromBot: botRef,
        requestId: z.string().min(1),
        ask: z.string(),
        answer: z.string().nullable(),
        failure: z.string().nullable(),
      }),
    ),
  }),
]);

export const botMessageRequestSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  toBotId: z.string().min(1),
  text: z.string().min(1),
  origin: botTurnOriginSchema,
  requestId: z.string().min(1).optional(),
});

export type BotMessageRequest = z.infer<typeof botMessageRequestSchema>;
