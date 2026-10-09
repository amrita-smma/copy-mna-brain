import { ChatAnthropic } from '@langchain/anthropic';
import { messageText } from './turnBudget';
import { DISABLED_THINKING } from '@/lib/ai/thinking';

const TITLE_MODEL = 'claude-haiku-5-5';
// Thinking is off (see below), so this only has to cover the title itself —
// with headroom for the newer tokenizer, which produces ~30% more tokens for
// the same text. The title is truncated to TITLE_MAX_CHARS downstream anyway.
const TITLE_MAX_TOKENS = 120;
export const TITLE_MAX_CHARS = 80;
const TITLE_MAX_WORDS = 8;

/**
 * Chat sidebar titling only — Haiku must not answer the user or refuse the
 * request. Weak prompts previously produced titles like
 * "I can't create or send files, but I can help you plan the presentation."
 */
export const CHAT_TITLE_SYSTEM_PROMPT =
  'You title chat threads for an M&A / investment research copilot sidebar. ' +
  "Given the user's first message, return a concise 2-6 word title that names " +
  "the topic. Match the message's subject and language. " +
  'You are NOT answering the user and you do NOT perform the task. ' +
  'Never refuse, apologize, explain capabilities, or write a full sentence. ' +
  'Return ONLY the title — no quotes, no trailing punctuation, no preamble. ' +
  'Examples: "Bank Mandiri deck", "L1 pipeline Excel", "Email SWOT summary", ' +
  '"Acme valuation comps".';

/** True when the model answered/refused instead of returning a short title. */
export function looksLikeAssistantReply(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (t.length > 60) return true;
  if (t.split(/\s+/).filter(Boolean).length > TITLE_MAX_WORDS) return true;
  if (
    /^(i\s+(can'?t|cannot|am unable|won'?t)|sorry|unfortunately|as an ai)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(but i can|i can help you|however i|i'?m (not|unable))\b/i.test(t)) {
    return true;
  }
  return false;
}

function fallbackTitleFromMessage(sourceMessage: string): string {
  return sourceMessage
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join(' ')
    .slice(0, TITLE_MAX_CHARS);
}

/**
 * Clean Haiku output into a sidebar title. If the model answered the user
 * instead of titling, fall back to a short slice of the source message.
 */
export function normalizeChatTitle(
  raw: string,
  sourceMessage: string,
): string | null {
  let title = String(raw)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim();

  if (!title || looksLikeAssistantReply(title)) {
    title = fallbackTitleFromMessage(sourceMessage);
  }

  title = title.slice(0, TITLE_MAX_CHARS).trim();
  return title || null;
}

/** One-shot Haiku call that returns a sidebar title (or null on failure). */
export async function generateChatTitle(
  firstUserMessage: string,
  apiKey: string,
): Promise<string | null> {
  const llm = new ChatAnthropic({
    model: TITLE_MODEL,
    anthropicApiKey: apiKey,
    // Haiku 5.5 rejects any non-default `temperature`.
    maxTokens: TITLE_MAX_TOKENS,
    // Naming a thread needs no reasoning. Haiku 5.5 still accepts thinking off
    // at effort `high` or below (Sonnet 5.5 and Opus 5.5 do not — see
    // @/lib/ai/thinking), so this pair is model-specific: switching TITLE_MODEL
    // to either of those means switching this to BETWEEN_TOOLS_THINKING or
    // adaptive. Set explicitly rather than relying on @langchain/anthropic's
    // default, which is this same value sent silently.
    thinking: DISABLED_THINKING,
    outputConfig: { effort: 'low' },
  });
  const res = await llm.invoke([
    { role: 'system', content: CHAT_TITLE_SYSTEM_PROMPT },
    { role: 'user', content: firstUserMessage },
  ]);
  // Not String(res.content): content is a block array whenever the model
  // returns anything but a lone string, and String() would stringify it as
  // "[object Object]".
  return normalizeChatTitle(messageText(res.content, ' '), firstUserMessage);
}
