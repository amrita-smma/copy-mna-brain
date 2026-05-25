// Public entrypoint for the mbox parser. Call `parseAndFilterMbox` to turn a
// raw mbox blob into cleaned, de-duplicated, filtered `ParsedEmail` records.
// Call `classifyByCustodian` to label each record as inbound/outbound vs a
// set of internal mailboxes (used by the Google Vault flow).

import {
  splitMboxMessages,
  streamMboxMessages,
  parseMessage,
  type ParsedEmail,
  type ParsedAddress,
} from './parser';
import { shouldSkip, type FilterOptions, type SkipReason } from './filter';

export type { ParsedEmail, ParsedAddress } from './parser';
export type { SkipReason, FilterOptions } from './filter';
export {
  splitMboxMessages,
  streamMboxMessages,
  parseMessage,
  parseAddresses,
  cleanBody,
  extractSignature,
  extractBody,
  stripHtml,
  parseHeaders,
} from './parser';
export {
  shouldSkip,
  isAutoReply,
  isNewsletter,
  isCalendarInvite,
  isInternalOnly,
} from './filter';
export {
  domainTag,
  findBodyCandidates,
  processEmail,
  updateContact,
  type Candidate,
  type ContactRow,
  type CountryCode,
  type EnrichedEmail,
  type LlmPayload,
  type ProcessEmailOptions,
} from './extract';
export {
  EMAIL_EXTRACTION_SCHEMA,
  SYSTEM_PROMPT,
  buildUserPrompt,
  mergePeopleWithCandidates,
  readQueue,
  safeCustomId,
  type EnrichedPerson,
  type EnrichedRecord,
  type EnrichmentError,
  type EnrichmentResult,
  type LlmExtraction,
  type LlmPerson,
  type QueueEntry,
} from './llmEnrich';

export interface ParseAndFilterOptions extends FilterOptions {
  minChars?: number;
  dropUrls?: boolean;
  noFilter?: boolean;
  auditFilter?: boolean;
  limit?: number;
}

export interface AuditedEmail extends ParsedEmail {
  filter_reason?: SkipReason;
}

export interface ParseAndFilterResult {
  records: AuditedEmail[];
  counts: {
    written: number;
    skipped: number;
    dupes: number;
    filtered: Record<string, number>;
  };
}

export function parseAndFilterMbox(
  mboxContent: string,
  opts: ParseAndFilterOptions = {},
): ParseAndFilterResult {
  const minChars = opts.minChars ?? 20;
  const dropUrls = opts.dropUrls ?? false;
  const noFilter = opts.noFilter ?? false;
  const auditFilter = opts.auditFilter ?? false;

  const records: AuditedEmail[] = [];
  const seenIds = new Set<string>();
  const filtered: Record<string, number> = {};
  let skipped = 0;
  let dupes = 0;

  for (const raw of splitMboxMessages(mboxContent)) {
    if (opts.limit && records.length >= opts.limit) break;

    let filterReason: SkipReason = '';
    if (!noFilter) {
      const result = shouldSkip(raw.headers, raw.rawBody, opts);
      if (result.skip) {
        filterReason = result.reason;
        filtered[result.reason] = (filtered[result.reason] ?? 0) + 1;
        if (!auditFilter) continue;
      }
    }

    let parsed: ParsedEmail;
    try {
      parsed = parseMessage(raw, { dropUrls });
    } catch {
      skipped++;
      continue;
    }

    if (parsed.message_id && seenIds.has(parsed.message_id)) {
      dupes++;
      continue;
    }
    if (parsed.message_id) seenIds.add(parsed.message_id);

    if (parsed.body.length < minChars) {
      skipped++;
      continue;
    }

    const record: AuditedEmail = filterReason ? { ...parsed, filter_reason: filterReason } : parsed;
    records.push(record);
  }

  return {
    records,
    counts: { written: records.length, skipped, dupes, filtered },
  };
}

// ─── Streaming variant ───────────────────────────────────────────────────────

export interface StreamCallbacks {
  onFilter?: (reason: SkipReason) => void;
  onSkip?: (kind: 'short' | 'parse' | 'dupe') => void;
}

// Generator equivalent of parseAndFilterMbox. Yields one AuditedEmail at a
// time and reports filter/skip events via optional callbacks, so the caller
// can stream emails into a DB without materializing the full mbox.
export async function* streamParseAndFilter(
  input: AsyncIterable<Uint8Array | string>,
  opts: ParseAndFilterOptions = {},
  cb: StreamCallbacks = {},
): AsyncGenerator<AuditedEmail> {
  const minChars = opts.minChars ?? 20;
  const dropUrls = opts.dropUrls ?? false;
  const noFilter = opts.noFilter ?? false;
  const auditFilter = opts.auditFilter ?? false;
  const seenIds = new Set<string>();
  let written = 0;

  for await (const raw of streamMboxMessages(input)) {
    if (opts.limit && written >= opts.limit) return;

    let filterReason: SkipReason = '';
    if (!noFilter) {
      const r = shouldSkip(raw.headers, raw.rawBody, opts);
      if (r.skip) {
        filterReason = r.reason;
        cb.onFilter?.(r.reason);
        if (!auditFilter) continue;
      }
    }

    let parsed: ParsedEmail;
    try {
      parsed = parseMessage(raw, { dropUrls });
    } catch {
      cb.onSkip?.('parse');
      continue;
    }

    if (parsed.message_id && seenIds.has(parsed.message_id)) {
      cb.onSkip?.('dupe');
      continue;
    }
    if (parsed.message_id) seenIds.add(parsed.message_id);

    if (parsed.body.length < minChars) {
      cb.onSkip?.('short');
      continue;
    }

    written++;
    yield filterReason ? { ...parsed, filter_reason: filterReason } : parsed;
  }
}

// ─── Custodian-based classification (Google Vault flow) ──────────────────────

export interface VaultImportMessage {
  contact_email: string;
  contact_name?: string;
  direction: 'inbound' | 'outbound';
  subject?: string;
  body: string;
  sent_at?: string;
  from_email?: string;
  to_email?: string;
}

export function classifyByCustodian(
  records: ParsedEmail[],
  custodianEmails: Set<string>,
): VaultImportMessage[] {
  const out: VaultImportMessage[] = [];
  for (const rec of records) {
    const fromEmail = rec.sender?.email ?? '';
    const toEmail = rec.recipients[0]?.email ?? '';
    const fromIsCustodian = fromEmail !== '' && custodianEmails.has(fromEmail);
    const toIsCustodian = toEmail !== '' && custodianEmails.has(toEmail);

    let direction: 'inbound' | 'outbound';
    let contactEmail = '';
    let contactName: string | undefined;

    if (fromIsCustodian && !toIsCustodian) {
      direction = 'outbound';
      contactEmail = toEmail;
      contactName = rec.recipients[0]?.name || undefined;
    } else if (!fromIsCustodian && toIsCustodian) {
      direction = 'inbound';
      contactEmail = fromEmail;
      contactName = rec.sender?.name || undefined;
    } else {
      // Both custodians (internal) or neither (CC'd) — skip.
      continue;
    }

    if (!contactEmail) continue;

    out.push({
      contact_email: contactEmail,
      contact_name: contactName,
      direction,
      subject: rec.subject || undefined,
      body: rec.body,
      sent_at: rec.date ?? undefined,
      from_email: fromEmail || undefined,
      to_email: toEmail || undefined,
    });
  }
  return out;
}
