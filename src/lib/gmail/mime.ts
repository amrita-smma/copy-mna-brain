import { randomUUID } from 'node:crypto';

/**
 * Builds the RFC 822 message `drafts.create` takes. Gmail fills in `From`,
 * `Date` and `Message-ID` itself for a draft, so none are set here.
 *
 * Everything that reaches a header is validated or stripped of line breaks:
 * recipients and the subject come from a model that read untrusted email, so a
 * value must never be able to start a header of its own (`Bcc:` injection).
 */

export interface DraftAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface DraftMimeInput {
  /** Bare addresses only (`a@b.com`), each passing {@link isMailboxAddress}. */
  to: string[];
  subject: string;
  /** The plain-text alternative. */
  text: string;
  /** The HTML alternative — what Gmail shows in the editor. */
  html: string;
  attachments?: DraftAttachment[];
}

/**
 * A bare address mail servers accept: a dot-atom local part, a dotted domain.
 * Deliberately narrower than RFC 5322 — no quoted local parts, no display
 * names, no comma or angle brackets — because a looser match lets one string
 * smuggle in a second recipient.
 */
const MAILBOX_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function isMailboxAddress(value: string): boolean {
  return value.length <= 254 && MAILBOX_RE.test(value);
}

/** Break base64 into the 76-character lines MIME requires. */
function wrapBase64(base64: string): string {
  return base64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

/** A header value with every control character (CR, LF, tab included) turned into a space. */
function oneLine(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]+/g, ' ').trim();
}

/**
 * The subject as a header value. Printable ASCII goes through as is; anything
 * else becomes RFC 2047 encoded words (`=?UTF-8?B?…?=`), cut on character
 * boundaries so no word splits a multi-byte character and each stays under the
 * 75-character limit.
 */
export function encodeSubject(subject: string): string {
  const clean = oneLine(subject);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf-8').toString('base64')}?=`);
    chunk = '';
  };
  for (const char of clean) {
    if (Buffer.byteLength(chunk + char, 'utf-8') > 45) flush();
    chunk += char;
  }
  flush();
  return words.join('\r\n ');
}

/** `filename="…"` for the old clients, plus RFC 5987 `filename*=` when the name isn't plain ASCII. */
function fileNameParams(param: 'filename' | 'name', filename: string): string {
  const cleaned =
      oneLine(filename).replace(/[\\/"]/g, '_').replace(/[\x00-\x1F\x7F]/g, '') || 'attachment';
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '_');
  const star =
    ascii === cleaned
      ? ''
      : `; ${param}*=UTF-8''${encodeURIComponent(cleaned).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  return `${param}="${ascii}"${star}`;
}

function safeContentType(value: string): string {
  const cleaned = oneLine(value);
  return /^[\w.+-]+\/[\w.+-]+$/.test(cleaned) ? cleaned : 'application/octet-stream';
}

function textPart(contentType: string, body: string): string[] {
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(body, 'utf-8').toString('base64')),
  ];
}

/** Throws when a recipient isn't a plain address — the tool validates first and says so to the model. */
export function buildDraftMime(input: DraftMimeInput): string {
  if (input.to.length === 0) throw new Error('A draft needs at least one recipient');
  const bad = input.to.find((address) => !isMailboxAddress(address));
  if (bad !== undefined) throw new Error(`Not a plain email address: ${oneLine(bad)}`);

  const id = randomUUID();
  const mixed = `----=_mna_mixed_${id}`;
  const alt = `----=_mna_alt_${id}`;
  const attachments = input.attachments ?? [];

  const alternative = [
    `--${alt}`,
    ...textPart('text/plain', input.text),
    `--${alt}`,
    ...textPart('text/html', input.html),
    `--${alt}--`,
  ];

  const headers = [
    'MIME-Version: 1.0',
    `To: ${input.to.join(',\r\n ')}`,
    `Subject: ${encodeSubject(input.subject)}`,
  ];

  if (attachments.length === 0) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...alternative, ''].join('\r\n');
  }

  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    ...alternative,
  ];
  for (const attachment of attachments) {
    lines.push(
      `--${mixed}`,
      `Content-Type: ${safeContentType(attachment.contentType)}; ${fileNameParams('name', attachment.filename)}`,
      `Content-Disposition: attachment; ${fileNameParams('filename', attachment.filename)}`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(attachment.content.toString('base64')),
    );
  }
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}

/** Gmail's `raw` field: the message as URL-safe base64. */
export function toBase64Url(message: string): string {
  return Buffer.from(message, 'utf-8').toString('base64url');
}
