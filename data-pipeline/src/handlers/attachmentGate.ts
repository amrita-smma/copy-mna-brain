import { eq, sql } from 'drizzle-orm';
import {
  emailAttachments,
  rawEmails,
  rawEmailEnrichments,
  domainClassifications,
} from '@/lib/db/schema';
import { EmailAttachmentRepository } from '../repositories';
import type { DbClient, Tables } from '@/lib/repositories';

export const ATTACHMENT_GATE_TIMEOUT_SECONDS = 300;
export const DEFAULT_LIMIT = 5000;

// Gate B: sender domain industries considered deal originators.
// Legal Services in, Management Consulting out (revisit on real data).
export const DEAL_ORIGINATOR_INDUSTRIES = new Set<string>([
  'Investment Banking',
  'Private Equity',
  'Asset Management',
  'Legal Services',
]);

// Gate C: email topics that strongly signal deal activity.
export const DEAL_TOPICS = new Set<string>([
  'nda',
  'term-sheet',
  'due-diligence',
  'valuation',
  'mou',
  'loi',
  'signing',
  'term-sheet-negotiation',
  'financial-model',
  'valuation-review',
  'bankability-study',
  'capex-analysis',
  'market-sounding',
  'fundraising',
  'exit',
  'ipo',
]);

// Terminal enrichment statuses — email will not be enriched further.
// Verified: crmLlmFetch.ts writes 'enriched', crmLlmSubmit.ts writes
// 'not_needed'. Do NOT use 'done'; that value is never written.
const TERMINAL_LLM_STATUSES = ['enriched', 'not_needed'];

export interface AttachmentGatePayload {
  limit?: number;
}

export interface AttachmentGateResult {
  evaluated: number;
  promoted: number;
  dropped: number;
  deferred: number;
}

const log = (msg: string) => console.log(`[attachment-gate] ${msg}`);

interface GateRow {
  attachment_id: string;
  from_address: string | null;
  llm_status: string;
  topics: string[] | null;
  related_companies: unknown;
  industry: string | null;
}

function hasDealCompanySignal(relatedCompanies: unknown): boolean {
  if (!Array.isArray(relatedCompanies) || relatedCompanies.length === 0) return false;
  return relatedCompanies.some(
    (rc: { confidence?: string }) =>
      rc.confidence === 'high' || rc.confidence === 'medium',
  );
}

function hasDealOriginatorDomain(industry: string | null): boolean {
  return industry != null && DEAL_ORIGINATOR_INDUSTRIES.has(industry);
}

function hasDealTopic(topics: string[] | null): boolean {
  if (!topics || topics.length === 0) return false;
  return topics.some((t) => DEAL_TOPICS.has(t));
}

export async function runAttachmentGate(
  payload: AttachmentGatePayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<AttachmentGateResult> {
  const limit = Math.max(1, payload.limit ?? DEFAULT_LIMIT);
  const repo = new EmailAttachmentRepository(deps.db);

  log(`starting job=${deps.job.id} limit=${limit}`);

  // Single SQL pass: join email_attachments(metadata_only) with raw_emails,
  // left-join enrichment + domain classification.
  const rows = await deps.db
    .select({
      attachment_id: emailAttachments.id,
      from_address: rawEmails.from_address,
      llm_status: rawEmails.llm_status,
      topics: rawEmailEnrichments.topics,
      related_companies: rawEmailEnrichments.related_companies,
      industry: domainClassifications.industry,
    })
    .from(emailAttachments)
    .innerJoin(rawEmails, eq(emailAttachments.message_id, rawEmails.message_id))
    .leftJoin(rawEmailEnrichments, eq(rawEmailEnrichments.raw_email_id, rawEmails.id))
    .leftJoin(
      domainClassifications,
      sql`lower(split_part(${rawEmails.from_address}, '@', 2)) = ${domainClassifications.domain}`,
    )
    .where(eq(emailAttachments.state, 'metadata_only'))
    .limit(limit) as GateRow[];

  const result: AttachmentGateResult = {
    evaluated: rows.length,
    promoted: 0,
    dropped: 0,
    deferred: 0,
  };

  if (rows.length === 0) {
    log('nothing to evaluate');
    return result;
  }

  const promoteByReason = new Map<'deal_company' | 'domain_industry' | 'deal_topic', string[]>();
  const toDrop: string[] = [];
  const toDefer: string[] = [];

  for (const row of rows) {
    // Gate A: related company with high/medium confidence
    if (hasDealCompanySignal(row.related_companies)) {
      const arr = promoteByReason.get('deal_company') ?? [];
      arr.push(row.attachment_id);
      promoteByReason.set('deal_company', arr);
      continue;
    }

    // Gate B: deal-originator domain
    if (hasDealOriginatorDomain(row.industry)) {
      const arr = promoteByReason.get('domain_industry') ?? [];
      arr.push(row.attachment_id);
      promoteByReason.set('domain_industry', arr);
      continue;
    }

    // Gate C: deal-signal topic
    if (hasDealTopic(row.topics)) {
      const arr = promoteByReason.get('deal_topic') ?? [];
      arr.push(row.attachment_id);
      promoteByReason.set('deal_topic', arr);
      continue;
    }

    // Email not yet terminally enriched — re-evaluate next run
    if (!TERMINAL_LLM_STATUSES.includes(row.llm_status)) {
      toDefer.push(row.attachment_id);
      continue;
    }

    // Email terminally enriched and no gates fired — drop
    toDrop.push(row.attachment_id);
  }

  // Promote in gate-reason batches
  for (const [gateReason, ids] of promoteByReason) {
    await repo.promoteToFetch(ids, gateReason);
    result.promoted += ids.length;
    log(`promoted ${ids.length} via gate=${gateReason}`);
  }

  if (toDrop.length > 0) {
    await repo.markDropped(toDrop);
    result.dropped = toDrop.length;
    log(`dropped ${toDrop.length}`);
  }

  result.deferred = toDefer.length;

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
