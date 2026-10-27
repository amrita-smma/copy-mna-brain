import type { ChatAnthropic } from '@langchain/anthropic';

/**
 * How to turn thinking off, per model family.
 *
 * `@langchain/anthropic` defaults its `thinking` field to `{type: 'disabled'}`
 * and sends it on every request, so a `ChatAnthropic` that never sets
 * `thinking` is not "unconfigured" — it actively asks for thinking off. That
 * is a 400 on half the current lineup:
 *
 * | Model         | `disabled`              | `between_tools`         |
 * | ------------- | ----------------------- | ----------------------- |
 * | Opus 5.5      | 400 — use adaptive      | 400                     |
 * | Sonnet 5.5    | **400 — use this file's `BETWEEN_TOOLS`** | OK at effort ≤ high |
 * | Haiku 5.5     | OK at effort ≤ high     | 400                     |
 * | Opus/Sonnet 5 | OK                      | 400                     |
 *
 * So every `ChatAnthropic` in this repo must set `thinking` explicitly, and
 * the value is model-dependent. Opus 5.5 has no off switch at all — it always
 * thinks, so pass `{type: 'adaptive'}` there.
 */
type ThinkingParam = ChatAnthropic['thinking'];

/**
 * Lowest thinking setting on Sonnet 5.5: no up-front thinking. With no tools
 * bound the response is text only, which is what `{type: 'disabled'}` did on
 * Sonnet 5. Rejected at `xhigh`/`max` effort, and it takes no other field —
 * sending `display` or `budget_tokens` alongside it is a 400.
 *
 * Cast because `@anthropic-ai/sdk` 0.74 predates `between_tools` and still
 * types the union as enabled | disabled | adaptive. Drop the cast once the SDK
 * carries the variant.
 */
export const BETWEEN_TOOLS_THINKING = {
  type: 'between_tools',
} as unknown as ThinkingParam;

/**
 * Thinking fully off. Valid on Haiku 5.5 (at effort `high` or below) and on
 * the Opus/Sonnet 5 generation — **not** on Sonnet 5.5 or Opus 5.5, which
 * reject it with a 400. Use `BETWEEN_TOOLS_THINKING` on Sonnet 5.5.
 */
export const DISABLED_THINKING = { type: 'disabled' } as const satisfies ThinkingParam;

/**
 * Adaptive thinking with the summary shown. The only valid setting on Opus
 * 5.5 (no off switch), and what the chat UI's reasoning panel streams: without
 * `display: 'summarized'` the thinking blocks arrive empty. It also carries the
 * inter-tool-call progress notes these models write as thinking.
 *
 * Cast because `@anthropic-ai/sdk` 0.74 lacks `display` on
 * ThinkingConfigAdaptive. Drop the cast once the SDK carries the field.
 */
export const ADAPTIVE_SUMMARIZED_THINKING = {
  type: 'adaptive',
  display: 'summarized',
} as unknown as ThinkingParam;
