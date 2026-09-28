/**
 * The composer decorates an outgoing message with markup the user never typed.
 *
 * `sendWithAttachments` (ChatProvider) appends a `📎 Attached: <fileName>` line
 * per attachment and a hidden `<!-- attach_id: … -->` marker so the optimistic
 * bubble can find its attachments again. Both travel to the server inside the
 * user turn's text.
 *
 * Anything that measures or summarizes "what the user said" must strip them
 * first: the title prompt does (otherwise Haiku titles the chat after a
 * filename), and so does `message_length` telemetry (otherwise an
 * attachment-only turn records a non-zero length, and a one-word prompt with a
 * long filename reads as a long message).
 */

const ATTACHMENT_LINE = /\n*📎 Attached: (.*)$/gm;
const ATTACH_ID_MARKER = /\n*<!-- attach_id: (.*?) -->/g;

/** The user's own text, with the composer's attachment markup removed. */
export function stripComposerMarkup(text: string): string {
  return text.replace(ATTACHMENT_LINE, '').replace(ATTACH_ID_MARKER, '').trim();
}
