import type { RunnableConfig } from '@langchain/core/runnables';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { gmailEnabled } from '@/lib/flags';
import { readBotToolContext } from '@/lib/bots/toolContext';
import { GmailApiError, type DraftAttachment } from '@/lib/gmail';
import { createContainer } from '@/lib/services/container';
import { GmailNotConnectedError, GmailScopeMissingError } from '@/lib/services/gmailService';

/**
 * How `send_email` reaches the user's own Gmail. A member who has connected
 * Gmail in a bot chat gets the email as a *draft* in their Drafts folder — never
 * a sent message — unless they asked for it to go out on behalf of Investment
 * Brain. Workforce runs have no chatting user, so they never reach this path.
 * See docs/features/gmail.md.
 */

/** Most recipients on one draft. A draft is reviewed by a person; this just keeps a runaway list out. */
export const GMAIL_DRAFT_MAX_RECIPIENTS = 25;

export type EmailRoute =
  /** Save a draft in this member's Gmail. */
  | { kind: 'draft'; userId: string; googleEmail: string | null }
  /** Send through the platform mailer (SES), as before. */
  | { kind: 'platform' }
  /** Gmail is connected but can't be used as asked; tell the model why. */
  | { kind: 'blocked'; message: string };

const SEND_AS_BRAIN_HINT =
  'Only if the user asks for it, you can instead call send_email again with send_as_brain=true to send it for real on behalf of Investment Brain (platform users only).';

export const NEEDS_RECONNECT_MESSAGE =
  `**Nothing was sent or saved.** The user's Gmail is connected, but without permission to create drafts (they connected before drafts existed, or left that box unticked). Ask them to open "Connect Apps" at the bottom of the sidebar (Profile → Connected apps), press Reconnect on Gmail, and keep every permission ticked; then ask again. ${SEND_AS_BRAIN_HINT}`;

/**
 * Decide where this email goes. Platform (SES) unless the turn is a bot chat
 * whose user has Gmail turned on, set up and connected, and did not ask for
 * Brain to send it.
 */
export async function resolveEmailRoute(
  runtime: RunnableConfig | undefined,
  sendAsBrain: boolean,
): Promise<EmailRoute> {
  if (sendAsBrain) return { kind: 'platform' };
  // No user in the turn config = a Workforce run (or a script): there is no mailbox to draft in.
  const ctx = readBotToolContext(runtime);
  if (!ctx) return { kind: 'platform' };
  // Belt and braces: a Workforce run never drafts, even if its config ever gains a `userId`.
  if ((runtime?.configurable as Record<string, unknown> | undefined)?.agentRole === 'workforce') {
    return { kind: 'platform' };
  }
  if (!(await gmailEnabled())) return { kind: 'platform' };

  const { gmailService } = createContainer(createDb(), await getActiveWorkspaceId());
  if (!gmailService.isConfigured()) return { kind: 'platform' };
  const status = await gmailService.getStatus(ctx.userId);
  if (!status.connected) return { kind: 'platform' };
  if (!status.canDraft) return { kind: 'blocked', message: NEEDS_RECONNECT_MESSAGE };
  return { kind: 'draft', userId: ctx.userId, googleEmail: status.googleEmail };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The draft's two bodies. No branded shell, banner or "sent on behalf of"
 * footer: it goes out under the member's own name, so it should read like
 * something they typed. An uploaded HTML page (already made email-safe) follows
 * the note.
 */
export function composeDraftBodies(input: { body: string; documentHtml?: string }): { text: string; html: string } {
  const note = `<div style="line-height:1.5;">${escapeHtml(input.body).replace(/\r?\n/g, '<br />')}</div>`;
  const document = input.documentHtml ? `<div style="margin-top:24px;">${input.documentHtml}</div>` : '';
  const text = input.documentHtml
    ? `${input.body}\n\n[The attached page is shown in the HTML version of this email.]`
    : input.body;
  return { text, html: `${note}${document}` };
}

/**
 * Where the member finds the draft: their Drafts folder, in the right account when we know it.
 * `?authuser=<email>` rather than `/mail/u/<email>/`: the path form 404s when that account
 * isn't signed in in the browser, while authuser falls back to Google's sign-in prompt.
 */
export function gmailDraftsUrl(googleEmail: string | null): string {
  const authuser = encodeURIComponent(googleEmail ?? '0');
  return `https://mail.google.com/mail/?authuser=${authuser}#drafts`;
}

export interface DraftOutcome {
  /** What the tool returns to the model. */
  message: string;
  ok: boolean;
}

/** Save the draft and describe the outcome for the model, whichever way it went. */
export async function saveGmailDraft(input: {
  route: Extract<EmailRoute, { kind: 'draft' }>;
  to: string[];
  subject: string;
  body: string;
  documentHtml?: string;
  attachments: DraftAttachment[];
  attachmentLabels: string[];
  notes: string[];
}): Promise<DraftOutcome> {
  try {
    const { gmailService } = createContainer(createDb(), await getActiveWorkspaceId());
    const bodies = composeDraftBodies({ body: input.body, documentHtml: input.documentHtml });
    const draft = await gmailService.createDraft(input.route.userId, {
      to: input.to,
      subject: input.subject,
      text: bodies.text,
      html: bodies.html,
      attachments: input.attachments,
    });
    const url = gmailDraftsUrl(draft.googleEmail ?? input.route.googleEmail);
    const where = draft.googleEmail ?? input.route.googleEmail;
    const withPart = input.attachmentLabels.length > 0 ? ` with ${input.attachmentLabels.join(' + ')}` : '';
    const parts = [
      `Saved as a DRAFT in ${where ? `the Gmail account ${where}` : "the user's Gmail"}${withPart} — **nothing was sent**. To: ${input.to.join(', ')}. Subject: "${input.subject}". Open Gmail drafts: ${url}`,
      ...(input.notes.length > 0 ? [input.notes.join(' ')] : []),
      "Tell the user the draft is waiting in their Gmail Drafts to review, edit and send, include the link, and do not say the email was sent. If they would rather it went out now on behalf of Investment Brain, they can ask for that (send_as_brain=true; platform users only).",
    ];
    return { ok: true, message: parts.join(' ') };
  } catch (err) {
    return { ok: false, message: draftFailureMessage(err) };
  }
}

export function draftFailureMessage(err: unknown): string {
  if (err instanceof GmailNotConnectedError) {
    return `**Nothing was sent or saved.** The user's Gmail connection has expired or was revoked. Ask them to open "Connect Apps" at the bottom of the sidebar (Profile → Connected apps) and press Connect on Gmail, then ask again. ${SEND_AS_BRAIN_HINT}`;
  }
  if (err instanceof GmailScopeMissingError) return NEEDS_RECONNECT_MESSAGE;
  if (err instanceof GmailApiError) {
    if (err.status === 429) {
      return `**Nothing was sent or saved.** Gmail is rate limiting requests${err.retryAfterSeconds ? `. Try again in ${err.retryAfterSeconds}s` : ''}.`;
    }
    if (err.status === 403) {
      return `**Nothing was sent or saved.** Gmail refused to create the draft (${err.message}). The user may need to reconnect Gmail from Connect Apps and keep every permission ticked. ${SEND_AS_BRAIN_HINT}`;
    }
    return `**Nothing was sent or saved.** Could not save the Gmail draft: ${err.message}`;
  }
  return `**Nothing was sent or saved.** Could not save the Gmail draft: ${err instanceof Error ? err.message : String(err)}`;
}
