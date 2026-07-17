import { ChatAnthropic } from '@langchain/anthropic';

const IMPROVE_MODEL = 'claude-haiku-4-5-20251001';
const IMPROVE_MAX_TOKENS = 500;
const IMPROVE_MAX_CHARS = 2000;

// Returned verbatim by the model when the input is too vague to improve; the
// helper maps it back to the user's original text so the draft is left as-is.
const KEEP_SENTINEL = 'KEEP_ORIGINAL_PROMPT';

const SYSTEM_PROMPT =
  'You are a prompt-improvement assistant for an M&A / investment research ' +
  'copilot. Rewrite the user-supplied text into the final, ready-to-send ' +
  'prompt that the user would type to the copilot — clearer, more specific, ' +
  'and more likely to get a high-quality answer, while preserving the ' +
  'original intent, subject, and language. Phrase it as the user’s own ' +
  'request (the same voice and point of view they used), NOT as an ' +
  'instruction about how to improve or answer it. Do not describe the task, ' +
  'add meta-commentary, or address an assistant in the third person — just ' +
  "produce the improved prompt itself. Keep it concise — don't pad it out. " +
  'Always improve any genuine request, even one that already reads clearly: ' +
  'at a minimum fix spelling, typos, grammar, and punctuation, and sharpen ' +
  'wording. Only when the text contains NO actual request at all — it is ' +
  'blank, a bare greeting, or a filler word like "please", "hi", or "help" ' +
  `— reply with exactly "${KEEP_SENTINEL}" and nothing else. NEVER ask the ` +
  'user for clarification or more information. Otherwise return ONLY the ' +
  'improved prompt text: no preamble, no quotes, no explanation, no markdown ' +
  'fences.';

/**
 * Rewrite a chat prompt into a clearer, more specific version using Haiku.
 * Mirrors the lightweight one-shot LLM pattern in
 * `generateWorkforceTitle` (src/lib/workforce/title.ts) and the chat-title
 * helper in src/app/api/chat/route.ts.
 *
 * When the input is too vague to improve, the model returns a sentinel and
 * this helper falls back to the user's original (trimmed) text, so an unclear
 * draft is kept as-is rather than replaced with a clarifying question.
 *
 * Throws if the key is missing or the model returns nothing usable — the
 * caller (the API route) maps those to an error response so the client can
 * surface a toast and leave the user's original text untouched.
 */
export async function improvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error('Cannot improve an empty prompt');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const llm = new ChatAnthropic({
    model: IMPROVE_MODEL,
    anthropicApiKey: apiKey,
    temperature: 0.3,
    maxTokens: IMPROVE_MAX_TOKENS,
  });

  const res = await llm.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: trimmed },
  ]);

  const improved = String(res.content).trim().slice(0, IMPROVE_MAX_CHARS);
  if (!improved) {
    throw new Error('Prompt improvement returned an empty result');
  }
  // Too-vague input: keep the user's original text untouched. Tolerate the
  // model wrapping the sentinel in quotes/punctuation.
  if (improved.replace(/["'.\s]/g, '') === KEEP_SENTINEL) {
    return trimmed;
  }
  return improved;
}
