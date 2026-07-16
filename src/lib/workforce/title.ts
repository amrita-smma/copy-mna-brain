import { ChatAnthropic } from '@langchain/anthropic';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { withBackgroundDb } from '@/lib/server/db';

const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const TITLE_MAX_TOKENS = 60;
const TITLE_MAX_CHARS = 80;

const SYSTEM_PROMPT =
  'You are titling an AI workforce task. Given the user prompt, return a ' +
  "concise 2-6 word title that names the work. Match the prompt's subject " +
  'and language. Return only the title — no quotes, no trailing punctuation. ' +
  'Examples: "Wet processing comps", "Deck for TechSlurry", ' +
  '"Korean TIM search", "Refresh Project Oriole".';

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
      temperature: 0,
      maxTokens: TITLE_MAX_TOKENS,
    });

    const res = await llm.invoke([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ]);

    const title = String(res.content).trim().slice(0, TITLE_MAX_CHARS);
    if (!title) return null;

    await withBackgroundDb(async (db) => {
      const repo = new AiWorkforceQueueRepository(db, await getActiveWorkspaceId());
      await repo.setTitle(runId, title);
    });
    return title;
  } catch (err) {
    console.error('[workforce] title generation failed:', err);
    return null;
  }
}
