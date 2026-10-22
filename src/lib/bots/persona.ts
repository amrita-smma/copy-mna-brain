/**
 * A bot's persona: the markdown its owner writes to say who the bot is and
 * what it does — its system prompt, as far as the owner can change it. It
 * starts blank; the owner fills it in by telling the bot (update_bot: written
 * at once on a private bot, confirmed on a card for a shared one) or in the
 * bot's settings. What one user asks the bot to remember about them is not
 * persona: that is the bot's memory of them (`./memoryTypes`).
 *
 * What every bot is told regardless — its name, how to use its tools, how to
 * hand work to another bot — is fixed, in `./prompt`, and never stored here.
 * Personas written before that move carry a managed block the app used to
 * render into them; `personaText` drops it. Client safe.
 */

const LEGACY_MANAGED_BLOCK = /<!-- managed:start[^>]*-->[\s\S]*?<!-- managed:end -->/;

/** The owner's persona text, without any legacy managed block, trimmed. */
export function personaText(md: string | null | undefined): string {
  return (md ?? '').replace(LEGACY_MANAGED_BLOCK, '').trim();
}
