/**
 * How a routine is described to the model, shared by `propose_create_routine`
 * (one routine for this bot) and `propose_create_bot` (routines a new bot
 * starts with): a title, the message the bot is sent, and a schedule in the
 * four shapes the routines service understands.
 */
import { z } from 'zod';

export const routineArgs = {
  title: z.string().min(1).describe('A short name for the routine, e.g. "Morning pipeline summary".'),
  message: z
    .string()
    .min(1)
    .describe(
      'The message sent to the bot each time the routine runs, as if the user typed it. Write it as the full task: what to look at and what to report.',
    ),
  schedule: z
    .enum(['daily', 'weekly', 'monthly', 'cron'])
    .describe('daily, weekly (on chosen weekdays), monthly (on a day of the month), or cron.'),
  time: z.string().optional().describe('24h "HH:MM" in the timezone, for daily, weekly and monthly.'),
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .optional()
    .describe('Weekly only: days to run, 0=Sunday … 6=Saturday. Weekdays are [1,2,3,4,5].'),
  day_of_month: z.number().int().min(1).max(31).optional().describe('Monthly only: 1–31 (31 runs on the last day).'),
  cron: z.string().optional().describe('Cron only: a 5-field cron expression.'),
  timezone: z
    .string()
    .optional()
    .describe('IANA timezone the time is in, e.g. "Asia/Jakarta". Leave out to use the user\'s browser timezone.'),
} as const;

export const routineArgsSchema = z.object(routineArgs);

export type RoutineArgs = z.infer<typeof routineArgsSchema>;

/** The `schedule_spec` the routines service expects, from the model's arguments. */
export function scheduleSpecFromArgs(args: RoutineArgs): Record<string, unknown> {
  switch (args.schedule) {
    case 'daily':
      return { time: args.time };
    case 'weekly':
      return { time: args.time, weekdays: args.weekdays ?? [] };
    case 'monthly':
      return { time: args.time, day: args.day_of_month };
    case 'cron':
      return { expression: args.cron };
  }
}

/**
 * The routine input the service validates and the card sends. The timezone
 * is left as the model gave it (possibly empty): the card fills in the
 * browser's zone when none was named.
 */
export function routineInputFromArgs(args: RoutineArgs) {
  return {
    title: args.title,
    prompt: args.message,
    schedule_kind: args.schedule,
    schedule_spec: scheduleSpecFromArgs(args),
    timezone: args.timezone ?? '',
  };
}
