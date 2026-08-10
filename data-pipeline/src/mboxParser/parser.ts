// TypeScript port of mna-mbox-parser/main.py (stage 1 — parse + clean).
// Splits an mbox blob into raw messages, then turns each raw message into a
// ParsedEmail with a cleaned body and parsed addresses. Filtering lives in
// ./filter.ts; the public entrypoint that combines parse + filter is index.ts.

import * as crypto from 'node:crypto';

export interface ParsedAddress {
  name: string;
  email: string;
}

export interface ParsedEmail {
  message_id: string;
  date: string | null;
  sender: ParsedAddress | null;
  recipients: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  body: string;
  // Sig block after the RFC 3676 `-- ` delimiter, with quoted replies stripped.
  // Empty string when no delimiter is present.
  signature: string;
}

export interface RawMessage {
  headers: Headers;
  rawBody: string;
}

export type Headers = Record<string, string[]>;

export interface ParseMessageOptions {
  dropUrls?: boolean;
}

// ─── Header parsing ──────────────────────────────────────────────────────────

function decodeEncodedWord(encoded: string): string {
  return encoded.replace(
    /=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g,
    (_, charset: string, encoding: string, text: string) => {
      try {
        const buf =
          encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text
                  .replace(/_/g, ' ')
                  .replace(/=([0-9A-Fa-f]{2})/g, (__, hex: string) =>
                    String.fromCharCode(parseInt(hex, 16)),
                  ),
                'binary',
              );
        return decodeBytes(buf, charset);
      } catch {
        return text;
      }
    },
  );
}

function decodeBytes(buf: Buffer, charset: string): string {
  const cs = charset.toLowerCase().trim();
  if (!cs || cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    return buf.toString('utf-8');
  }
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

export function parseHeaders(raw: string): Headers {
  // RFC 5322 unfolding: continuation lines start with whitespace.
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = decodeEncodedWord(line.slice(colon + 1).trim());
    if (!headers[key]) headers[key] = [];
    headers[key].push(value);
  }
  return headers;
}

export function getHeader(headers: Headers, name: string): string {
  const v = headers[name.toLowerCase()];
  return v && v.length > 0 ? v[0] : '';
}

export function getAllHeaders(headers: Headers, name: string): string[] {
  return headers[name.toLowerCase()] ?? [];
}

// ─── Address parsing ─────────────────────────────────────────────────────────

// Split a header value on commas that are NOT inside double quotes or
// angle brackets. Python's email.utils.getaddresses handles this — we need
// the same for headers like `"Doe, John" <a@x.com>, Other <b@y.com>`.
function splitAddressList(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let buf = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && raw[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      buf += ch;
    } else if (!inQuotes && ch === '<') {
      depth++;
      buf += ch;
    } else if (!inQuotes && ch === '>') {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (!inQuotes && depth === 0 && ch === ',') {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

const ADDR_RE = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>@\s]+@[^>@\s]+)>\s*$/;
const BARE_ADDR_RE = /^\s*([\w.+%!#$&'*+/=?^_`{|}~-]+@[\w.-]+\.[A-Za-z]{2,})\s*$/;

export function parseAddresses(raw: string): ParsedAddress[] {
  if (!raw) return [];
  const out: ParsedAddress[] = [];
  for (const part of splitAddressList(raw)) {
    const m = part.match(ADDR_RE);
    if (m) {
      out.push({ name: (m[1] ?? '').trim(), email: m[2].trim().toLowerCase() });
      continue;
    }
    const bare = part.match(BARE_ADDR_RE);
    if (bare) {
      out.push({ name: '', email: bare[1].trim().toLowerCase() });
    }
  }
  return out;
}

// ─── HTML stripping ──────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set(['br', 'p', 'div', 'tr', 'li']);
const SKIP_TAGS = new Set(['script', 'style', 'head']);

export function stripHtml(html: string): string {
  // Drop entire <script>, <style>, <head> blocks before generic tag-stripping.
  let s = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');

  // Replace block-level tags with newlines so paragraph structure survives.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (full, tag: string) => {
    return BLOCK_TAGS.has(tag.toLowerCase()) ? '\n' : SKIP_TAGS.has(tag.toLowerCase()) ? '' : ' ';
  });

  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)));
}

// ─── Body extraction ─────────────────────────────────────────────────────────

function decodeQuotedPrintable(s: string, charset: string): string {
  // Drop soft line breaks, then turn =XX hex pairs into raw bytes, then decode.
  const collapsed = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i];
    if (ch === '=' && /[0-9A-Fa-f]/.test(collapsed[i + 1] ?? '') && /[0-9A-Fa-f]/.test(collapsed[i + 2] ?? '')) {
      bytes.push(parseInt(collapsed.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return decodeBytes(Buffer.from(bytes), charset);
}

function decodePart(body: string, encoding: string, charset: string): string {
  const enc = (encoding || '').toLowerCase().trim();
  if (enc === 'base64') {
    try {
      return decodeBytes(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body, charset);
  return body;
}

function parseContentType(ct: string): { type: string; params: Record<string, string> } {
  const [first, ...rest] = ct.split(';');
  const params: Record<string, string> = {};
  for (const param of rest) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    const k = param.slice(0, eq).trim().toLowerCase();
    let v = param.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { type: first.trim().toLowerCase(), params };
}

const HTML_TAG_RE = /<[a-zA-Z][^>]*>/;

interface MimePart {
  contentType: string;
  contentTypeRaw: string;
  charset: string;
  encoding: string;
  body: string;
  disposition: string;
}

function walkMime(headers: Headers, body: string): MimePart[] {
  const contentTypeHeader = getHeader(headers, 'content-type') || 'text/plain';
  const { type, params } = parseContentType(contentTypeHeader);
  const encoding = getHeader(headers, 'content-transfer-encoding');
  const disposition = getHeader(headers, 'content-disposition') || '';

  if (!type.startsWith('multipart/')) {
    return [
      {
        contentType: type,
        contentTypeRaw: contentTypeHeader,
        charset: params.charset || 'utf-8',
        encoding,
        body,
        disposition,
      },
    ];
  }

  const boundary = params.boundary;
  if (!boundary) return [];

  const parts: MimePart[] = [];
  const chunks = body.split(`--${boundary}`);
  for (const chunk of chunks) {
    const trimmed = chunk.replace(/^\r?\n/, '');
    if (!trimmed || trimmed.startsWith('--')) continue;
    const divider = trimmed.search(/\r?\n\r?\n/);
    if (divider === -1) continue;
    const dividerLen = trimmed[divider] === '\r' ? 4 : 2;
    const partHeaders = parseHeaders(trimmed.slice(0, divider));
    const partBody = trimmed.slice(divider + dividerLen);
    parts.push(...walkMime(partHeaders, partBody));
  }
  return parts;
}

export function extractBody(headers: Headers, rawBody: string): string {
  const parts = walkMime(headers, rawBody);
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  for (const part of parts) {
    if (part.disposition.toLowerCase().includes('attachment')) continue;
    if (part.contentType === 'text/plain') {
      textParts.push(decodePart(part.body, part.encoding, part.charset));
    } else if (part.contentType === 'text/html') {
      htmlParts.push(decodePart(part.body, part.encoding, part.charset));
    }
  }

  if (textParts.length > 0) {
    let text = textParts.join('\n');
    if (HTML_TAG_RE.test(text)) text = stripHtml(text);
    // If text/plain is a placeholder ("Your email client does not support HTML.")
    // prefer the substantially-larger HTML alternative.
    if (htmlParts.length > 0 && text.trim().length < 100) {
      const htmlText = stripHtml(htmlParts.join('\n'));
      if (htmlText.trim().length > text.trim().length) return htmlText;
    }
    return text;
  }
  if (htmlParts.length > 0) return stripHtml(htmlParts.join('\n'));
  return '';
}

// ─── Attachment extraction (MB-214) ─────────────────────────────────────────

export const ATTACHMENT_MIME_ALLOWLIST = new Set<string>([
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export const ATTACHMENT_MIN_BYTES = 20_000;
export const ATTACHMENT_MAX_BYTES = 25_000_000;

export interface AttachmentMeta {
  part_index: number;
  filename: string | null;
  mime_type: string;
  encoding: string;
  content_hash: string;
  size_bytes: number;
}

function parseFilename(disposition: string, contentType: string): string | null {
  const dispMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
  if (dispMatch) return decodeURIComponent(dispMatch[1].trim());
  const ctMatch = contentType.match(/name=["']?([^"';\r\n]+)["']?/i);
  if (ctMatch) return ctMatch[1].trim();
  return null;
}

export function extractAttachments(headers: Headers, rawBody: string): AttachmentMeta[] {
  const parts = walkMime(headers, rawBody);
  const result: AttachmentMeta[] = [];
  let globalIndex = 0;

  for (const part of parts) {
    const index = globalIndex++;
    if (!part.disposition.toLowerCase().includes('attachment')) continue;

    const mimeType = part.contentType.split(';')[0].trim().toLowerCase();
    if (!ATTACHMENT_MIME_ALLOWLIST.has(mimeType)) continue;

    const approxBytes = Math.floor(part.body.length * 3 / 4);
    if (approxBytes < ATTACHMENT_MIN_BYTES || approxBytes > ATTACHMENT_MAX_BYTES) continue;

    const contentHash = crypto.createHash('sha256').update(part.body).digest('hex');

    result.push({
      part_index: index,
      filename: parseFilename(part.disposition, part.contentTypeRaw),
      mime_type: mimeType,
      encoding: part.encoding,
      content_hash: contentHash,
      size_bytes: approxBytes,
    });
  }

  return result;
}

export interface RawAttachmentPart {
  mime_type: string;
  encoding: string;
  content_hash: string;
  body: string;
  filename: string | null;
}

/**
 * Walk MIME parts and return raw attachment bodies for single-pass gating and
 * Smart Files delivery. No MIME/size filtering happens at this parsing layer.
 */
export function extractRawAttachmentParts(headers: Headers, rawBody: string): RawAttachmentPart[] {
  const parts = walkMime(headers, rawBody);
  const result: RawAttachmentPart[] = [];
  for (const part of parts) {
    if (!part.disposition.toLowerCase().includes('attachment')) continue;
    const mimeType = part.contentType.split(';')[0].trim().toLowerCase();
    result.push({
      mime_type: mimeType,
      encoding: part.encoding,
      content_hash: crypto.createHash('sha256').update(part.body).digest('hex'),
      body: part.body,
      filename: parseFilename(part.disposition, part.contentTypeRaw),
    });
  }
  return result;
}

// ─── Body cleaning ───────────────────────────────────────────────────────────

// Matches "On ... wrote:", French/German/Indonesian equivalents,
// "-----Original Message-----", "From: ...", and mobile signatures.
const QUOTE_INTRO_RE =
  /^\s*(on .+wrote:|le .+a écrit\s*:|am .+schrieb.*:|pada .+menulis:|-{2,}\s*original message\s*-{2,}|from:\s.+|sent from my .+)$/i;
// Gmail: "---------- Forwarded message ---------"
// Outlook: "________________________________" (32 underscores)
const FORWARDED_SEPARATOR_RE = /^(-{3,}\s*forwarded message\s*-{3,}|_{10,})$/i;
const URL_RE = /https?:\/\/\S+|www\.\S+/g;
const WHITESPACE_RE = /[ \t]+/g;
const MULTI_NEWLINE_RE = /\n{3,}/g;
// U+200B-200F: zero-width + LTR/RTL marks. U+202A-202E: bidi embedding/override.
// U+FEFF: BOM. All invisible — stripped so the body's character count matches
// what a human sees. Escape form avoids GitHub's bidirectional-Unicode warning.
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

// Pulls the signature block out of an email body. We walk the raw (post-MIME,
// post-HTML-strip) text looking for the RFC 3676 `-- ` delimiter, then collect
// the lines that follow it until a quoted reply intro is reached. Returns ''
// when no delimiter is present, which is the common case for emails without a
// proper sig (Outlook inline sigs, short replies, etc.).
export function extractSignature(text: string): string {
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(ZERO_WIDTH_RE, '');
  const lines = normalized.split('\n');

  let sigStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith('>')) continue;
    // Reply intro before any delimiter — this email's sig (if any) was inside
    // the quoted thread, not on this message.
    if (QUOTE_INTRO_RE.test(stripped)) return '';
    if (stripped === '--') {
      sigStart = i + 1;
      break;
    }
  }

  if (sigStart === -1) return '';

  const sigLines: string[] = [];
  for (let i = sigStart; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith('>')) break;
    if (QUOTE_INTRO_RE.test(stripped)) break;
    sigLines.push(lines[i]);
  }

  return sigLines.join('\n').trim().replace(WHITESPACE_RE, ' ').replace(MULTI_NEWLINE_RE, '\n\n');
}

export function cleanBody(text: string, dropUrls = false): string {
  if (!text) return '';
  let s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(ZERO_WIDTH_RE, '');

  const lines: string[] = [];
  let inForwardedHeader = false;
  for (const line of s.split('\n')) {
    const stripped = line.trim();
    if (stripped.startsWith('>')) continue;
    if (FORWARDED_SEPARATOR_RE.test(stripped)) {
      inForwardedHeader = true;
      continue;
    }
    if (inForwardedHeader) {
      // Skip From/Sent/Date/To/Subject metadata lines; resume on first blank line
      if (stripped === '') inForwardedHeader = false;
      continue;
    }
    if (QUOTE_INTRO_RE.test(stripped)) break;
    if (stripped === '--' || line.replace(/\s+$/, '') === '-- ') break;
    lines.push(line);
  }

  s = lines.join('\n');
  if (dropUrls) s = s.replace(URL_RE, '');
  s = s.replace(WHITESPACE_RE, ' ').replace(MULTI_NEWLINE_RE, '\n\n');
  return s.trim();
}

// ─── Date / message assembly ─────────────────────────────────────────────────

export function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw; // mirror Python: return raw on parse failure
  return d.toISOString();
}

export function parseMessage(raw: RawMessage, opts: ParseMessageOptions = {}): ParsedEmail {
  const bodyRaw = extractBody(raw.headers, raw.rawBody);
  const senderList = parseAddresses(getHeader(raw.headers, 'from'));
  const recipients = parseAddresses(getHeader(raw.headers, 'to'));
  const cc = parseAddresses(getAllHeaders(raw.headers, 'cc').join(', '));
  return {
    message_id: getHeader(raw.headers, 'message-id'),
    date: normalizeDate(getHeader(raw.headers, 'date')),
    sender: senderList[0] ?? null,
    recipients,
    cc,
    subject: getHeader(raw.headers, 'subject'),
    body: cleanBody(bodyRaw, opts.dropUrls ?? false),
    signature: extractSignature(bodyRaw),
  };
}

// ─── mbox splitting ──────────────────────────────────────────────────────────

function parseRawMessage(msgText: string): RawMessage | null {
  if (!msgText) return null;
  const text = msgText.replace(/\r\n/g, '\n');
  const firstNl = text.indexOf('\n');
  if (firstNl === -1) return null;
  const afterEnvelope = text.slice(firstNl + 1);
  const hbDivider = afterEnvelope.indexOf('\n\n');
  if (hbDivider === -1) return null;
  return {
    headers: parseHeaders(afterEnvelope.slice(0, hbDivider)),
    rawBody: afterEnvelope.slice(hbDivider + 2).replace(/^>From /gm, 'From '),
  };
}

export function splitMboxMessages(mboxContent: string): RawMessage[] {
  const content = mboxContent.replace(/\r\n/g, '\n');
  const out: RawMessage[] = [];

  const boundaryRe = /^From \S/gm;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = boundaryRe.exec(content)) !== null) starts.push(m.index);

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : content.length;
    const msg = parseRawMessage(content.slice(start, end));
    if (msg) out.push(msg);
  }

  return out;
}

// Streaming variant — reads chunks of bytes (or strings) from any
// AsyncIterable and yields one RawMessage at a time. Peak memory is
// roughly the size of the largest single message in the mbox, not the
// whole file. Use with fs.createReadStream(path), Response.body, etc.
export async function* streamMboxMessages(
  input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<RawMessage> {
  // Lazy import keeps the synchronous code path free of the Node-only
  // StringDecoder dependency.
  const { StringDecoder } = await import('node:string_decoder');
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  function* drain(eof: boolean): Generator<RawMessage> {
    while (true) {
      let start: number;
      if (buffer.startsWith('From ')) {
        start = 0;
      } else {
        const idx = buffer.indexOf('\nFrom ');
        if (idx === -1) {
          if (eof) buffer = '';
          return;
        }
        start = idx + 1;
      }

      const next = buffer.indexOf('\nFrom ', start + 5);
      if (next === -1) {
        if (eof) {
          const msg = parseRawMessage(buffer.slice(start));
          if (msg) yield msg;
          buffer = '';
          return;
        }
        // Incomplete trailing message — keep it and wait for more chunks.
        buffer = buffer.slice(start);
        return;
      }

      const msg = parseRawMessage(buffer.slice(start, next + 1));
      if (msg) yield msg;
      buffer = buffer.slice(next + 1);
    }
  }

  for await (const chunk of input) {
    if (typeof chunk === 'string') {
      buffer += chunk;
    } else {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer += decoder.write(buf);
    }
    yield* drain(false);
  }
  buffer += decoder.end();
  yield* drain(true);
}
