import { z } from 'zod';
import { isHtmlAttachment } from '@/lib/insights/largeDocument';
import { toEmailSafeHtml, type RemovedCounts } from '@/lib/email/emailSafeHtml';
import {
  isChatAttachmentRef,
  type ChatAttachmentRef,
} from '@/lib/services/chatAttachmentService';

/**
 * Sending an HTML file the user uploaded in chat as the body of an email.
 *
 * The model never retypes the document: it names the file, and the bytes are
 * read straight back out of S3 — a large file only ever reaches the model as
 * an outline (see `formatLargeHtmlAttachmentBlock`), so anything the model
 * wrote itself would be a reconstruction, not the file.
 *
 * The file is not put on the wire unchanged. Mail clients run no JavaScript
 * and strip most of what a modern page is built from, so the document is first
 * rewritten into the static subset they render (`toEmailSafeHtml`). A page
 * whose content only appears once its scripts run has nothing left to send —
 * that is reported as an error rather than mailed as a blank sheet.
 */

/** The `attached_html` argument of `send_email`. */
export const attachedHtmlSpecSchema = z.object({
  file_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Name of the uploaded HTML file to send as the email body. Omit when the chat carries exactly one HTML attachment.',
    ),
});

export type AttachedHtmlSpec = z.infer<typeof attachedHtmlSpecSchema>;

function validRefs(value: unknown): ChatAttachmentRef[] {
  return Array.isArray(value) ? value.filter(isChatAttachmentRef) : [];
}

/**
 * The chat attachments a tool may act on this turn: the files attached to THIS
 * turn, or — when it has none — those of the thread's most recent user turn
 * that had any (`priorAttachments`, resolved and ownership-checked by the chat
 * route). A user who uploads a file on one turn and asks for it to be emailed
 * on the next still reaches the file.
 */
export function turnAttachmentRefs(
  configurable: Record<string, unknown> | undefined,
): ChatAttachmentRef[] {
  const current = validRefs(configurable?.attachments);
  if (current.length > 0) return current;
  return validRefs(configurable?.priorAttachments);
}

/** The HTML files among the turn's attachments, in upload order. */
export function htmlAttachments(refs: ChatAttachmentRef[]): ChatAttachmentRef[] {
  return refs.filter((ref) => isHtmlAttachment(ref.contentType, ref.fileName));
}

/**
 * The outcome of naming a file: exactly one of `ref` (the file to send) and
 * `error` (what to tell the user instead) is set.
 */
export interface ResolvedHtmlAttachment {
  ref: ChatAttachmentRef | null;
  error: string | null;
}

/** Compare file names the way a user types them: case- and path-insensitively. */
function nameKey(fileName: string): string {
  return fileName.trim().toLowerCase().split(/[\\/]/).pop() ?? '';
}

/**
 * Which uploaded HTML file `spec` refers to. Ambiguity is an error rather than
 * a guess: emailing the wrong document to a colleague is not something the
 * user can take back.
 */
export function resolveHtmlAttachment(
  refs: ChatAttachmentRef[],
  spec: AttachedHtmlSpec,
): ResolvedHtmlAttachment {
  const candidates = htmlAttachments(refs);
  if (candidates.length === 0) {
    return {
      ref: null,
      error:
        'no HTML file is attached to this chat. Ask the user to upload the .html file in the composer, then send it.',
    };
  }

  const requested = spec.file_name ? nameKey(spec.file_name) : null;
  if (!requested) {
    if (candidates.length > 1) {
      return {
        ref: null,
        error: `${candidates.length} HTML files are attached (${candidates
          .map((c) => c.fileName)
          .join(', ')}). Pass attached_html.file_name to say which one to send.`,
      };
    }
    return { ref: candidates[0], error: null };
  }

  const matches = candidates.filter((c) => nameKey(c.fileName) === requested);
  if (matches.length === 0) {
    return {
      ref: null,
      error: `no attached HTML file is named "${spec.file_name}". Attached: ${candidates
        .map((c) => c.fileName)
        .join(', ')}.`,
    };
  }
  // Same name uploaded twice — the newest upload is the one the user means.
  return { ref: matches[matches.length - 1], error: null };
}

/**
 * Decode the downloaded file as UTF-8, dropping a BOM. A BOM left in front of
 * `<!doctype html>` shows up as a stray character in some mail clients.
 */
export function decodeHtml(buffer: Buffer): string {
  const text = buffer.toString('utf-8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}


/**
 * Decode the downloaded file and reformat it for email.
 *
 * `html` is the fragment to send, or null with `error` explaining — in the
 * words the sender should hear — why the document cannot be emailed at all.
 * `note` summarises what the rewrite removed, so the tool can say so instead
 * of quietly delivering a thinner page than the file on disk.
 */
export interface PreparedAttachedHtml {
  html: string | null;
  error: string | null;
  note: string | null;
}

export function prepareAttachedHtml(buffer: Buffer, fileName: string): PreparedAttachedHtml {
  const raw = decodeHtml(buffer);
  if (!raw.trim()) {
    return {
      html: null,
      error: `the attached file "${fileName}" is empty, so there is nothing to send.`,
      note: null,
    };
  }

  const safe = toEmailSafeHtml(raw);
  if (!safe.html) {
    // Quote what the page does show: "all it renders is 'B Unpacking…'" is the
    // sentence that makes the refusal land, because it is exactly what the
    // recipient would otherwise have received.
    const shows = safe.residue
      ? `all it renders without them is "${safe.residue}"`
      : 'without them the page is blank';
    return {
      html: null,
      error:
        safe.failure === 'js-only'
          ? `"${fileName}" builds its content with JavaScript, which no email client runs — ${shows}, so nothing was sent. Send it as a PDF instead, or ask for a version of the file whose content is in the HTML itself.`
          : `"${fileName}" has no content to send once the markup is reduced to what email clients render, so nothing was sent.`,
      note: null,
    };
  }

  return { html: safe.html, error: null, note: describeRemoved(safe.removed) };
}

/** "3 scripts, 1 chart canvas and 2 images that would not load" — or null. */
export function describeRemoved(removed: RemovedCounts): string | null {
  const parts: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (removed.scripts > 0) parts.push(plural(removed.scripts, 'script'));
  if (removed.canvases > 0) parts.push(plural(removed.canvases, 'chart canvas', 'chart canvases'));
  if (removed.frames > 0) parts.push(plural(removed.frames, 'embedded frame'));
  if (removed.stylesheets > 0) parts.push(plural(removed.stylesheets, 'external stylesheet'));
  if (removed.unreachableImages > 0) {
    parts.push(`${plural(removed.unreachableImages, 'image')} that could not load`);
  }
  if (parts.length === 0) return null;
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `reformatted for email (removed ${list})`;
}
