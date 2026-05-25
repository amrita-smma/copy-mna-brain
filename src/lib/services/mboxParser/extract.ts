// TypeScript port of mna-mbox-parser/extract.py. Reads cleaned ParsedEmail
// records and emits per-email enrichment + a deduped contacts table + an
// LLM-ready queue. The LLM only sees what the deterministic pass couldn't
// resolve.
//
// Faithful to the Python original except for two corrections:
//   1. LOCAL_TAGS patterns no longer contain '@' (the Python ones never matched
//      because the local-part has '@' stripped before comparison).
//   2. Signature context prefers ParsedEmail.signature (the post-`-- ` block)
//      when present, falling back to the "last 20 non-empty lines" heuristic.
//      This was added once the parser learned to capture signatures cleanly.
import type { ParsedAddress, ParsedEmail } from './parser';

// Two-letter ISO country code used to disambiguate local-format phones (e.g.
// `0812-...`). Kept compatible with libphonenumber-js's CountryCode type for
// when/if we re-introduce it.
export type CountryCode = string;

const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;

// Phone candidates in free text. We accept an optional `+`, then at least 8
// total digits with up to 25 chars of digit/separator soup in between. This
// is intentionally permissive — false positives are filtered downstream by
// the LLM step. The Python original used `phonenumbers.PhoneNumberMatcher`
// which we can't use here (its Node port has ESM/CJS interop issues under
// tsx); regex-then-normalize is the pragmatic substitute.
const PHONE_RE = /\+?\d(?:[\d\s().-]{6,22}\d)/g;
// Local prefixes by region, used to convert local-format numbers to a
// `+CC...` shape. Extend as the inbox grows.
const REGION_TRUNK_CC: Record<string, string> = {
  ID: '62',
  SG: '65',
  MY: '60',
  US: '1',
  GB: '44',
};

function normalizePhone(raw: string, region: CountryCode): string | null {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (!cleaned) return null;

  let digits: string;
  if (cleaned.startsWith('+')) {
    digits = cleaned.slice(1);
  } else if (cleaned.startsWith('0')) {
    const cc = REGION_TRUNK_CC[region.toUpperCase()];
    if (!cc) return null;
    digits = cc + cleaned.slice(1);
  } else {
    digits = cleaned;
  }

  // Reject anything outside an E.164 plausible length (min 8, max 15 digits).
  if (digits.length < 8 || digits.length > 15) return null;
  if (!/^\d+$/.test(digits)) return null;
  return `+${digits}`;
}

// Sender-domain → topic tag. Extend as you learn your inbox.
const DOMAIN_TAGS: Record<string, string> = {
  'bloomberg.com': 'finance-news',
  'economist.com': 'finance-news',
  'preqin.com': 'finance-data',
  'linkedin.com': 'professional-networking',
  'github.com': 'developer',
  'notion.so': 'productivity-saas',
  'slack.com': 'productivity-saas',
  'google.com': 'google-account',
  'calendar.google.com': 'calendar',
  'github.io': 'developer',
  'stripe.com': 'billing',
  'paypal.com': 'billing',
  'amazon.com': 'shopping',
  'semicon.org': 'industry-event',
  'cvent.com': 'event-registration',
  'hslu.ch': 'academic',
};

// Local-part patterns → topic tag (matched after domain).
const LOCAL_TAGS: Array<[string, string]> = [
  ['noreply', 'automated'],
  ['no-reply', 'automated'],
  ['donotreply', 'automated'],
  ['notifications', 'automated'],
  ['newsletter', 'marketing'],
  ['marketing', 'marketing'],
  ['info', 'automated'],
  ['billing', 'billing'],
  ['invoice', 'billing'],
  ['support', 'support'],
  ['subscriptions', 'subscription'],
];

export function domainTag(addr: string): string | null {
  if (!addr || !addr.includes('@')) return null;
  const lower = addr.toLowerCase();
  const [local, domain] = lower.split('@', 2);
  for (const [pattern, tag] of Object.entries(DOMAIN_TAGS)) {
    if (domain.includes(pattern)) return tag;
  }
  for (const [pattern, tag] of LOCAL_TAGS) {
    if (local.includes(pattern)) return tag;
  }
  return null;
}

export interface Candidate {
  type: 'email' | 'phone';
  value: string;
  context: string;
}

// Walks the body looking for email/phone candidates with ±2 lines of context.
// Dedupes by (type, value), keeping the longest context seen.
export function findBodyCandidates(body: string, defaultRegion: CountryCode = 'ID'): Candidate[] {
  if (!body) return [];
  const lines = body.split('\n');
  const byValue = new Map<string, Candidate>();

  const add = (kind: 'email' | 'phone', value: string, snippet: string) => {
    const key = `${kind}\0${value}`;
    const cleanSnippet = snippet.replace(/\s+/g, ' ').trim();
    const existing = byValue.get(key);
    if (!existing) {
      byValue.set(key, { type: kind, value, context: cleanSnippet });
    } else if (cleanSnippet && cleanSnippet.length > existing.context.length) {
      existing.context = cleanSnippet;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    EMAIL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMAIL_RE.exec(line)) !== null) {
      const snippet = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      add('email', m[0].toLowerCase(), snippet);
    }
  }

  PHONE_RE.lastIndex = 0;
  let phoneMatch: RegExpExecArray | null;
  while ((phoneMatch = PHONE_RE.exec(body)) !== null) {
    const normalized = normalizePhone(phoneMatch[0], defaultRegion);
    if (!normalized) continue;
    const lineIdx = body.slice(0, phoneMatch.index).split('\n').length - 1;
    const snippet = lines.slice(Math.max(0, lineIdx - 2), lineIdx + 3).join('\n');
    add('phone', normalized, snippet);
  }

  return Array.from(byValue.values());
}

// Build a "signature context" string for a parsed email. Prefer the cleanly-
// captured ParsedEmail.signature when the parser found a `-- ` delimiter;
// otherwise fall back to the last 20 non-empty body lines (the Python
// heuristic) so we still have something for inline signatures.
function buildSigContext(rec: ParsedEmail): string {
  if (rec.signature && rec.signature.trim().length > 0) {
    return rec.signature.replace(/\s+/g, ' ').trim();
  }
  const sigLines = (rec.body ?? '').split('\n').filter((l) => l.trim().length > 0);
  return sigLines.slice(-20).join(' ').replace(/\s+/g, ' ').trim();
}

export interface LlmPayload {
  body_snippet: string;
  candidates: Candidate[];
  want_topics: boolean;
  want_names: boolean;
}

export interface EnrichedEmail {
  message_id: string;
  date: string | null;
  subject: string;
  sender: { email: string; name: string };
  recipients: ParsedAddress[];
  cc: ParsedAddress[];
  domain_tag: string | null;
  candidates: Candidate[];
  needs_llm: boolean;
  llm_payload: LlmPayload | null;
}

export interface ProcessEmailOptions {
  defaultRegion?: CountryCode;
  bodyChars?: number;
}

export function processEmail(rec: ParsedEmail, opts: ProcessEmailOptions = {}): EnrichedEmail {
  const defaultRegion = opts.defaultRegion ?? 'ID';
  const bodyChars = opts.bodyChars ?? 6000;

  const senderAddr = (rec.sender?.email ?? '').toLowerCase();
  const senderName = rec.sender?.name ?? '';
  const recipients = rec.recipients ?? [];
  const cc = rec.cc ?? [];

  const tagFromDomain = domainTag(senderAddr);

  const body = rec.body ?? '';
  const signature = rec.signature ?? '';
  // Scan body and signature separately, then merge. Combined scanning would
  // bleed signature text into the ±2-line context window of body candidates
  // (e.g. attaching the sender's role/phone to an internal recipient who
  // happened to appear on the line right before the `-- ` delimiter).
  let candidates = findBodyCandidates(body, defaultRegion);
  if (signature) {
    const merged = new Map(candidates.map((c) => [`${c.type}\0${c.value}`, c]));
    for (const sigCand of findBodyCandidates(signature, defaultRegion)) {
      const key = `${sigCand.type}\0${sigCand.value}`;
      const existing = merged.get(key);
      if (!existing || sigCand.context.length > existing.context.length) {
        merged.set(key, sigCand);
      }
    }
    candidates = Array.from(merged.values());
  }

  const sigContext = buildSigContext(rec);

  // Add sender as a candidate using the signature as context. Even if their
  // address already appears in the body, prefer the signature context — it's
  // the richest source for role/company.
  const bodyEmailValues = new Set(
    candidates.filter((c) => c.type === 'email').map((c) => c.value),
  );
  if (senderAddr) {
    if (bodyEmailValues.has(senderAddr)) {
      candidates = candidates.map((c) =>
        c.type === 'email' && c.value === senderAddr ? { ...c, context: sigContext } : c,
      );
    } else {
      candidates = [{ type: 'email', value: senderAddr, context: sigContext }, ...candidates];
    }
  }

  // Upgrade external recipient/CC candidates to the signature context when
  // they appear in the body and the sig is richer. Recipients not in the body
  // already have name+email from headers, so we skip them.
  const senderDomain = senderAddr.includes('@') ? senderAddr.split('@')[1] : '';
  for (const addrInfo of [...recipients, ...cc]) {
    const addr = (addrInfo.email ?? '').toLowerCase();
    if (!addr || addr === senderAddr) continue;
    const addrDomain = addr.includes('@') ? addr.split('@')[1] : '';
    if (addrDomain === senderDomain) continue;
    if (!bodyEmailValues.has(addr)) continue;
    candidates = candidates.map((c) =>
      c.type === 'email' && c.value === addr && sigContext.length > c.context.length
        ? { ...c, context: sigContext }
        : c,
    );
  }

  const needsTopic = tagFromDomain === null;
  const needsNames = candidates.length > 0;

  return {
    message_id: rec.message_id,
    date: rec.date,
    subject: rec.subject,
    sender: { email: senderAddr, name: senderName },
    recipients,
    cc,
    domain_tag: tagFromDomain,
    candidates,
    needs_llm: needsTopic || needsNames,
    llm_payload:
      needsTopic || needsNames
        ? {
            body_snippet: body.slice(0, bodyChars),
            candidates,
            want_topics: needsTopic,
            want_names: needsNames,
          }
        : null,
  };
}

export interface ContactRow {
  email: string;
  name: string;
  count: number;
  last_seen: string;
}

// Accumulate contact stats into the dedup table. Mirrors Python's
// `update_contact`: longest non-empty name wins, latest date wins, count++.
export function updateContact(
  table: Map<string, ContactRow>,
  addr: string,
  name: string,
  date: string,
): void {
  if (!addr) return;
  const key = addr.toLowerCase();
  const entry = table.get(key) ?? { email: key, name: '', count: 0, last_seen: '' };
  entry.count += 1;
  if (name && name.length > entry.name.length) entry.name = name;
  if (date && date > entry.last_seen) entry.last_seen = date;
  table.set(key, entry);
}
