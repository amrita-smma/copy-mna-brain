/**
 * What a turn searches memory with. The user's current words are the query —
 * but a short follow-up ("ok do that", "what about them?") embeds to almost
 * nothing on its own, so when the message is short the previous user turn
 * is prepended for context. A long message carries its own context and is
 * searched as is: adding more only dilutes the embedding.
 */

/** A message at or under this length gets the previous user turn prepended. */
export const SHORT_QUERY_CHARS = 60;
/** How much of the previous turn is kept. */
export const PREVIOUS_TURN_CHARS = 300;

export function recallQueryFor(current: string, previousUser?: string | null): string {
  const now = current.trim();
  const before = previousUser?.trim() ?? '';
  if (!now) return before ? clip(before) : '';
  if (now.length > SHORT_QUERY_CHARS || !before) return now;
  return `${clip(before)}\n${now}`;
}

function clip(text: string): string {
  return text.length > PREVIOUS_TURN_CHARS ? `${text.slice(0, PREVIOUS_TURN_CHARS).trimEnd()}…` : text;
}
