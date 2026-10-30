/**
 * Turning a Gmail API `users.messages` resource into what the model reads:
 * headers, plain text and an attachment list. Pure — no I/O.
 */

/** Longest body handed back for one message; a newsletter can run to megabytes. */
export const GMAIL_BODY_MAX_CHARS = 12_000;

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailRawMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  /** ISO 8601, from Gmail's `internalDate` (when it received the message). */
  date: string | null;
  snippet: string;
  unread: boolean;
  labels: string[];
}

export interface GmailAttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailMessage extends GmailMessageSummary {
  cc: string | null;
  body: string;
  /** True when `body` was cut at {@link GMAIL_BODY_MAX_CHARS}. */
  bodyTruncated: boolean;
  /** Names only — attachment contents are never fetched. */
  attachments: GmailAttachmentInfo[];
}

function header(payload: GmailPart | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = payload?.headers?.find((h) => h.name?.toLowerCase() === wanted);
  return found?.value?.trim() || null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** A readable plain-text rendering of an HTML email body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: GmailAttachmentInfo[];
}

function collect(part: GmailPart, out: Collected): void {
  if (part.filename) {
    out.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body?.size ?? 0,
    });
  } else if (part.body?.data) {
    if (part.mimeType === 'text/plain') out.plain.push(decodeBase64Url(part.body.data));
    else if (part.mimeType === 'text/html') out.html.push(decodeBase64Url(part.body.data));
  }
  for (const child of part.parts ?? []) collect(child, out);
}

function summarize(raw: GmailRawMessage): GmailMessageSummary {
  const millis = Number(raw.internalDate);
  return {
    id: raw.id,
    threadId: raw.threadId ?? null,
    from: header(raw.payload, 'From'),
    to: header(raw.payload, 'To'),
    subject: header(raw.payload, 'Subject'),
    date: Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : null,
    snippet: raw.snippet ?? '',
    unread: raw.labelIds?.includes('UNREAD') ?? false,
    labels: raw.labelIds ?? [],
  };
}

/** A message fetched with `format=metadata`: headers and snippet, no body. */
export function parseMessageSummary(raw: GmailRawMessage): GmailMessageSummary {
  return summarize(raw);
}

/** A message fetched with `format=full`: headers, plain-text body and attachment names. */
export function parseMessage(raw: GmailRawMessage): GmailMessage {
  const collected: Collected = { plain: [], html: [], attachments: [] };
  if (raw.payload) collect(raw.payload, collected);

  // Prefer the sender's own text/plain alternative; fall back to the HTML.
  const text = collected.plain.length
    ? collected.plain.join('\n\n').trim()
    : htmlToText(collected.html.join('\n\n'));
  const bodyTruncated = text.length > GMAIL_BODY_MAX_CHARS;

  return {
    ...summarize(raw),
    cc: header(raw.payload, 'Cc'),
    body: bodyTruncated ? text.slice(0, GMAIL_BODY_MAX_CHARS) : text,
    bodyTruncated,
    attachments: collected.attachments,
  };
}
