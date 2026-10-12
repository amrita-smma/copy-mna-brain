import { ChatAnthropic } from '@langchain/anthropic';
import { messageText } from '@/lib/chat/turnBudget';
import { DISABLED_THINKING } from '@/lib/ai/thinking';
import { flushLangfuse, withLangfuseCallbacks } from '@/lib/langfuse';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { withBackgroundDb } from '@/lib/server/db';

const TITLE_MODEL = 'claude-haiku-5-5';
// See src/lib/chat/title.ts — thinking is off; headroom is for the newer
// tokenizer, which produces ~30% more tokens for the same text.
const TITLE_MAX_TOKENS = 120;
export const TITLE_MAX_CHARS = 80;

const SYSTEM_PROMPT =
  'You are titling an AI workforce task. Given the user prompt, return a ' +
  "concise 2-6 word title that names the work. Match the prompt's subject " +
  'and language. Return only the title — no quotes, no trailing punctuation. ' +
  'Examples: "Wet processing comps", "Deck for TechSlurry", ' +
  '"Korean TIM search", "Refresh Project Oriole".';

/**
 * Persist a known title to ai_workforce_queue.title. Best-effort — failures are
 * logged and swallowed so callers don't crash on persistence errors.
 */
export async function persistWorkforceTitle(
  runId: string,
  title: string,
): Promise<void> {
  try {
    await withBackgroundDb(async (db) => {
      const repo = new AiWorkforceQueueRepository(db, await getActiveWorkspaceId());
      await repo.setTitle(runId, title);
    });
  } catch (err) {
    console.error('[workforce] title persist failed:', err);
  }
}

/**
 * Generate a human-friendly title for a workforce task using Haiku and persist
 * it to ai_workforce_queue.title. Best-effort — failures are logged and
 * swallowed so callers (typically inside `after()`) don't crash on title gen
 * errors. Mirrors the chat title pattern in src/app/api/chat/route.ts.
 */
export async function generateWorkforceTitle(
  runId: string,
  prompt: string,
): Promise<string | null> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn(
        '[workforce] title generation skipped: ANTHROPIC_API_KEY unset',
      );
      return null;
    }

    const llm = new ChatAnthropic({
      model: TITLE_MODEL,
      anthropicApiKey: apiKey,
      // Haiku 5.5 rejects any non-default `temperature`.
      maxTokens: TITLE_MAX_TOKENS,
      // Titling needs no reasoning; valid on Haiku at effort <= high. See
      // @/lib/ai/thinking before pointing TITLE_MODEL at Sonnet/Opus 5.5.
      thinking: DISABLED_THINKING,
      outputConfig: { effort: 'low' },
    });

    const res = await llm.invoke(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      withLangfuseCallbacks({ runName: 'workforce.title' }),
    );

    // Runs inside enqueue's `after()`, which no other drain covers.
    await flushLangfuse();

    // Not String(res.content): content is a block array whenever the model
    // returns anything but a lone string.
    const title = messageText(res.content, ' ').trim().slice(0, TITLE_MAX_CHARS);
    if (!title) return null;

    await persistWorkforceTitle(runId, title);
    return title;
  } catch (err) {
    console.error('[workforce] title generation failed:', err);
    return null;
  }
}
