/**
 * A bot's background turn as a Vercel Workflow run — how one bot messages
 * another (an @mention, the fan-in reply, a routine firing). The start payload
 * is the message: which user, which bot, which text, the request it answers,
 * and the `jobs` row that audits it.
 *
 * Started by `startBotMessageRun` (`./botMessageRun.ts`); the work is the one
 * step in `./botMessageStep.ts`. A `'use workflow'` body must only await
 * `'use step'` functions (see ARCHITECTURE.md), so nothing else lives here.
 */
import { runBotMessageStep, type BotMessageRunInput } from './botMessageStep';

export type { BotMessageRunInput } from './botMessageStep';

export async function botMessageWorkflow(input: BotMessageRunInput): Promise<void> {
  'use workflow';
  await runBotMessageStep(input);
}
