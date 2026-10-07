/**
 * One place to clip a company's free-form Context before it goes into a model
 * prompt.
 *
 * `companies.context` is a user-authored markdown document with no length bound
 * — a deal team can paste a whole call transcript into the Context tab. Every
 * surface that inlines it (the AI Opinion instruction, the AI Company Card job,
 * per-slide generation, emailed presentation specs) therefore has to cap it, or
 * one verbose company swamps the prompt it was meant to inform.
 *
 * The cap lives here rather than per-caller so the limits cannot silently drift
 * apart, and so a caller that needs to say "there is more" can tell whether it
 * actually clipped anything.
 */

/**
 * Default ceiling for an inlined Context, in characters. Comfortably holds a
 * normal multi-section Context note while bounding the pathological case.
 */
export const COMPANY_CONTEXT_PROMPT_MAX_CHARS = 4_000;

export interface ClippedCompanyContext {
  /** Trimmed context, clipped to the limit and suffixed with `…` when cut. Empty when there is none. */
  text: string;
  /** True only when characters were actually dropped. */
  truncated: boolean;
}

/**
 * Trim a company's Context and clip it to `maxChars`.
 *
 * A whitespace-only context reads as no context at all — the editor saves what
 * the user left behind, so blank-but-present is the normal "cleared" state.
 */
export function clipCompanyContext(
  context: string | null | undefined,
  maxChars: number = COMPANY_CONTEXT_PROMPT_MAX_CHARS,
): ClippedCompanyContext {
  const trimmed = context?.trim() ?? '';
  if (!trimmed) return { text: '', truncated: false };
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, maxChars)}…`, truncated: true };
}
