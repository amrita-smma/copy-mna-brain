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

// One-on-one / personal catch-up subject markers. Matched against the subject
// only (both calendar invites and reply threads carry the subject), so the
// filter stays deterministic and cheap.
const ONE_ON_ONE_PATTERNS: RegExp[] = [
  /\b1\s*[:/-]\s*1\b/, //     "1:1", "1-1", "1 / 1"
  /\bone[\s-]on[\s-]one\b/, // "one-on-one", "one on one"
];

// Clearly personal / social phrases. Conservative: these only win when the
// subject has NO deal language (see DEAL_KEYWORD_PATTERNS below).
const PERSONAL_SOCIAL_PATTERNS = [
  'catch up',
  'catch-up',
  'catchup',
  'coffee',
  'lunch',
  'dinner',
  'breakfast',
  'drinks',
  'happy hour',
  'happy birthday',
  'birthday',
  'congratulations',
  'congrats',
  'condolences',
  'get well',
];

// If any of these appear in the subject, we never treat the email as personal —
// it is deal/business substance regardless of a social-sounding word.
const DEAL_KEYWORD_PATTERNS: RegExp[] = [
  /\bnda\b/,
  /\bterm[-\s]?sheet\b/,
  /\bdue[-\s]?diligence\b/,
  /\bvaluation\b/,
  /\bmandate\b/,
  /\bacquisition\b/,
  /\bmerger\b/,
  /\bloi\b/,
  /\bmou\b/,
  /\bdivestment\b/,
  /\bdisposal\b/,
  /\bfundrais/,
  /\bfinancing\b/,
  /\bipo\b/,
  /\bproject\b/,
];

export type SkipReason =
  | ''
  | 'auto_reply'
  | 'newsletter'
  | 'calendar_invite'
  | 'internal_only'
  | 'personal';

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

/**
 * Conservative detector for personal / 1-1 catch-up emails (both meeting
 * invites and reply threads). Fires only on the subject and only when there is
 * no deal language present, so genuine deal threads that happen to mention a
 * lunch/coffee are never dropped.
 */
export function isPersonalOrOneOnOne(headers: Headers): boolean {
  const subj = getHeader(headers, 'subject').toLowerCase();
  if (!subj) return false;
  // Deal language always wins — never treat these as personal.
  if (DEAL_KEYWORD_PATTERNS.some((re) => re.test(subj))) return false;
  if (ONE_ON_ONE_PATTERNS.some((re) => re.test(subj))) return true;
  return PERSONAL_SOCIAL_PATTERNS.some((p) => subj.includes(p));
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
  if (isPersonalOrOneOnOne(headers)) return { skip: true, reason: 'personal' };
  if (opts.dropInternalOnly && isInternalOnly(headers, opts.ourDomains ?? new Set())) {
    return { skip: true, reason: 'internal_only' };
  }
  return { skip: false, reason: '' };
}
