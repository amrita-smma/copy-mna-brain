// TypeScript port of mna-mbox-parser/filter.py.
// Decides whether to skip an mbox message before we spend time parsing it.
// Operates on the raw header map produced by ./parser.ts so the same headers
// flow into both filter and parse.

import type { Headers } from './parser';
import { getHeader, getAllHeaders, parseAddresses } from './parser';

const AUTO_REPLY_HEADERS = [
  'auto-submitted',
  'x-autoreply',
  'x-autorespond',
  'x-auto-response-suppress',
];

const NEWSLETTER_HEADERS = [
  'list-unsubscribe',
  'x-campaign-id',
  'x-mailgun-tag',
  'x-mc-user',
  'feedback-id',
];

const AUTO_REPLY_PRECEDENCE = new Set(['auto_reply']);
const NEWSLETTER_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

const OOO_SUBJECT_PATTERNS = [
  'out of office',
  'out-of-office',
  'ooo:',
  'automatic reply',
  'auto-reply',
  'auto reply',
  'away from',
  'vacation reply',
  'abwesenheitsnotiz', // German
  'réponse automatique', // French
  'balasan otomatis', // Indonesian
];

const NEWSLETTER_LOCAL_PARTS = ['noreply', 'no-reply', 'donotreply', 'newsletter', 'marketing'];

export type SkipReason =
  | ''
  | 'auto_reply'
  | 'newsletter'
  | 'calendar_invite'
  | 'internal_only';

export interface FilterOptions {
  ourDomains?: Set<string>;
  dropInternalOnly?: boolean;
}

export function isAutoReply(headers: Headers): boolean {
  for (const h of AUTO_REPLY_HEADERS) {
    if (getHeader(headers, h)) return true;
  }
  const prec = getHeader(headers, 'precedence').toLowerCase();
  if (AUTO_REPLY_PRECEDENCE.has(prec)) return true;
  const subj = getHeader(headers, 'subject').toLowerCase();
  return OOO_SUBJECT_PATTERNS.some((p) => subj.includes(p));
}

export function isNewsletter(headers: Headers, senderLocal = ''): boolean {
  for (const h of NEWSLETTER_HEADERS) {
    if (getHeader(headers, h)) return true;
  }
  const prec = getHeader(headers, 'precedence').toLowerCase();
  if (NEWSLETTER_PRECEDENCE.has(prec)) return true;
  if (senderLocal && NEWSLETTER_LOCAL_PARTS.some((p) => senderLocal.includes(p))) return true;
  return false;
}

export function isCalendarInvite(headers: Headers, rawBody: string): boolean {
  const ct = getHeader(headers, 'content-type').toLowerCase();
  if (ct.startsWith('text/calendar') || ct.startsWith('application/ics')) return true;
  // For multipart messages, scan part headers for a calendar Content-Type
  // without re-walking the full MIME tree.
  if (ct.startsWith('multipart/')) {
    if (/Content-Type:\s*(text\/calendar|application\/ics)\b/i.test(rawBody)) return true;
  }
  return false;
}

function domainsIn(header: string): string[] {
  return parseAddresses(header)
    .map((a) => a.email.split('@')[1])
    .filter((d): d is string => !!d);
}

export function isInternalOnly(headers: Headers, ourDomains: Set<string>): boolean {
  if (ourDomains.size === 0) return false;
  const senders = domainsIn(getHeader(headers, 'from'));
  const recipients = [
    ...domainsIn(getHeader(headers, 'to')),
    ...domainsIn(getAllHeaders(headers, 'cc').join(', ')),
    ...domainsIn(getAllHeaders(headers, 'bcc').join(', ')),
  ];
  if (senders.length === 0 || recipients.length === 0) return false;
  return [...senders, ...recipients].every((d) => ourDomains.has(d));
}

export interface SkipResult {
  skip: boolean;
  reason: SkipReason;
}

export function shouldSkip(
  headers: Headers,
  rawBody: string,
  opts: FilterOptions = {},
): SkipResult {
  if (isAutoReply(headers)) return { skip: true, reason: 'auto_reply' };

  const fromList = parseAddresses(getHeader(headers, 'from'));
  const senderEmail = fromList[0]?.email ?? '';
  const [senderLocal] = senderEmail.split('@');

  if (isNewsletter(headers, senderLocal ?? '')) return { skip: true, reason: 'newsletter' };
  if (isCalendarInvite(headers, rawBody)) return { skip: true, reason: 'calendar_invite' };
  if (opts.dropInternalOnly && isInternalOnly(headers, opts.ourDomains ?? new Set())) {
    return { skip: true, reason: 'internal_only' };
  }
  return { skip: false, reason: '' };
}
