import { eq, inArray, isNotNull, sql } from 'drizzle-orm';

import {
  correspondents,
  emailParticipants,
  emails as emailsTable,
  emailTopics,
  employers,
  rawEmails as rawEmailsTable,
} from '@/lib/db/schema';
import {
  DomainClassificationRepository,
  MartRepository,
  RawEmailEnrichmentRepository,
} from '../repositories';
import {
  CorrespondentRepository,
  EmailRepository,
  EmployerDomainRepository,
  EmployerOverrideRepository,
  EmployerRepository,
  TopicRepository,
} from '@/lib/repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import type { EnrichedPerson } from '../mboxParser';

export const VAULT_CRM_INGEST_TIMEOUT_SECONDS = 1800; // 30 minutes
export const DEFAULT_LIMIT = 5000;
export const MAX_LIMIT = 20000;

type RawEmailRow = Tables<'raw_emails'>;
type RawEmailEnrichmentRow = Tables<'raw_email_enrichments'>;
type DomainClassificationRow = Tables<'domain_classifications'>;

export interface CrmIngestPayload {
  rawEmailIds?: string[];
  limit?: number;
}

export interface CrmIngestResult {
  rows_ingested: number;
  rows_excluded: number;
  topics_upserted: number;
  employers_upserted: number;
  correspondents_upserted: number;
  emails_inserted: number;
  emails_skipped_dupe: number;
  participants_inserted: number;
  email_topics_inserted: number;
  employer_topics_inserted: number;
  /** Analytics marts refreshed after this ingest (RFC MB-205 §Phase 5). */
  marts_refreshed: string[];
}

const log = (msg: string) => console.log(`[crm-ingest] ${msg}`);

interface DomainEntry {
  name: string;
  internal?: boolean;
  industry?: string | null;
}
interface DomainConfig {
  map: Map<string, DomainEntry>;
  excluded: Set<string>;
}

// MB-205: domain overrides now live in the `employer_overrides` table (curatable
// in-app), not scripts/domains.json. Resolution rows (employer_name set) build
// the map; `excluded` rows build the drop-set.
async function loadDomainConfig(
  overrideRepo: EmployerOverrideRepository,
): Promise<DomainConfig> {
  const rows = await overrideRepo.listAll();
  const map = new Map<string, DomainEntry>();
  const excluded = new Set<string>();
  for (const r of rows) {
    const domain = r.domain.toLowerCase();
    if (r.excluded) excluded.add(domain);
    if (r.employer_name) {
      map.set(domain, {
        name: r.employer_name,
        internal: r.internal,
        industry: r.industry,
      });
    }
  }
  return { map, excluded };
}

function domainOf(email: string): string {
  const i = email.indexOf('@');
  return i === -1 ? '' : email.slice(i + 1).toLowerCase();
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

interface ResolvedEmployer {
  name: string;
  internal: boolean;
  industry: string | null;
}

function resolveEmployer(
  domain: string,
  domainMap: Map<string, DomainEntry>,
  classified: Map<string, DomainClassificationRow>,
): ResolvedEmployer {
  const curated = domainMap.get(domain);
  const cls = classified.get(domain);
  const trustCls = cls && cls.confidence !== 'low';

  if (curated) {
    const industry =
      curated.industry ?? (trustCls ? cls?.industry ?? null : null);
    return { name: curated.name, internal: !!curated.internal, industry };
  }

  if (trustCls && cls?.name) {
    return {
      name: cls.name,
      internal: false,
      industry: cls.industry ?? null,
    };
  }

  // Fallback: titlecase the first label of the domain.
  const first = (domain.split('.')[0] || domain).toLowerCase();
  return {
    name: first.charAt(0).toUpperCase() + first.slice(1),
    internal: false,
    industry: trustCls ? cls?.industry ?? null : null,
  };
}

function buildPersonIndex(
  enrichments: RawEmailEnrichmentRow[],
): Map<string, EnrichedPerson> {
  const idx = new Map<string, EnrichedPerson>();
  const score = (p: EnrichedPerson) =>
    (p.name ? 1 : 0) +
    (p.role ? 1 : 0) +
    (p.company ? 1 : 0) +
    (p.phone ? 1 : 0);
  for (const e of enrichments) {
    const people = (e.people as EnrichedPerson[] | null) ?? [];
    for (const p of people) {
      if (!p.email) continue;
      const key = p.email.toLowerCase();
      const existing = idx.get(key);
      if (!existing || score(p) > score(existing)) idx.set(key, p);
    }
  }
  return idx;
}

export async function runCrmIngest(
  payload: CrmIngestPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<CrmIngestResult> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, payload.limit ?? DEFAULT_LIMIT));
  const enrichmentRepo = new RawEmailEnrichmentRepository(deps.db);
  const domainRepo = new DomainClassificationRepository(deps.db);
  const topicRepo = new TopicRepository(deps.db);
  const employerRepo = new EmployerRepository(deps.db);
  const correspondentRepo = new CorrespondentRepository(deps.db);
  const emailRepo = new EmailRepository(deps.db);
  const overrideRepo = new EmployerOverrideRepository(deps.db);
  const employerDomainRepo = new EmployerDomainRepository(deps.db);

  const result: CrmIngestResult = {
    rows_ingested: 0,
    rows_excluded: 0,
    topics_upserted: 0,
    employers_upserted: 0,
    correspondents_upserted: 0,
    emails_inserted: 0,
    emails_skipped_dupe: 0,
    participants_inserted: 0,
    email_topics_inserted: 0,
    employer_topics_inserted: 0,
    marts_refreshed: [],
  };

  // 1. Resolve target rows.
  let targets: RawEmailRow[];
  if (payload.rawEmailIds && payload.rawEmailIds.length > 0) {
    targets = await deps.db
      .select()
      .from(rawEmailsTable)
      .where(inArray(rawEmailsTable.id, payload.rawEmailIds));
  } else {
    targets = await enrichmentRepo.listReadyForIngest(limit);
  }

  log(`starting job=${deps.job.id} targets=${targets.length}`);
  if (targets.length === 0) {
    log('nothing to ingest');
    return result;
  }

  // 2. Load enrichments + curated config.
  const enrichments = await enrichmentRepo.findByRawEmailIds(
    targets.map((t) => t.id),
  );
  const enrichmentByRawId = new Map<string, RawEmailEnrichmentRow>();
  for (const e of enrichments) enrichmentByRawId.set(e.raw_email_id, e);
  const personByEmail = buildPersonIndex(enrichments);

  const { map: domainMap, excluded: excludedDomains } =
    await loadDomainConfig(overrideRepo);
  // Resolve-once (RFC §6): a domain already mapped to an employer reuses that
  // stable id forever, so reverse-ETL/overlays always re-attach.
  const persistedDomainToEmployerId = await employerDomainRepo.loadMap();

  // 3. Exclusion filter.
  const isExcluded = (email: string | undefined | null) =>
    excludedDomains.has(domainOf(email ?? ''));
  const rowsToIngest = targets.filter((r) => !isExcluded(r.from_address));
  result.rows_excluded = targets.length - rowsToIngest.length;

  if (rowsToIngest.length === 0) {
    log('all targets excluded by domain');
    return result;
  }

  // 4. Compute unique domains touched and look up classifications.
  const uniqueDomains = new Set<string>();
  for (const r of rowsToIngest) {
    const sd = domainOf(r.from_address ?? '');
    if (sd) uniqueDomains.add(sd);
    for (const addr of [...(r.to_addresses ?? []), ...(r.cc_addresses ?? [])]) {
      const d = domainOf(addr);
      if (d) uniqueDomains.add(d);
    }
  }
  const classifiedRows = await domainRepo.findManyByDomains(
    [...uniqueDomains],
  );
  const classifiedByDomain = new Map<string, DomainClassificationRow>();
  for (const c of classifiedRows) classifiedByDomain.set(c.domain, c);

  // 5. Unique slugs across enrichments.
  const uniqueSlugs = new Set<string>();
  for (const e of enrichments) {
    for (const t of (e.topics as string[] | null) ?? []) {
      const slug = normalize(t);
      if (slug) uniqueSlugs.add(slug);
    }
  }

  log(
    `ingest set: ${rowsToIngest.length} emails / ${uniqueDomains.size} domains / ${uniqueSlugs.size} topics`,
  );

  await deps.db.transaction(async (tx) => {
    // PgTransaction is API-compatible with DbClient for our query patterns,
    // but missing the `$client` property TS expects on PostgresJsDatabase.
    // We only ever call .insert/.update/.select on it, so the unknown-cast is
    // safe in practice.
    const txClient = tx as unknown as DbClient;
    const txTopicRepo = new TopicRepository(txClient);
    const txEmployerRepo = new EmployerRepository(txClient);
    const txCorrespondentRepo = new CorrespondentRepository(txClient);
    const txEmailRepo = new EmailRepository(txClient);

    // [1/7] Topics.
    log('[1/7] topics');
    const topicRows = await txTopicRepo.upsertBatch([...uniqueSlugs]);
    const slugToTopicId = new Map<string, string>();
    for (const t of topicRows) slugToTopicId.set(t.slug, t.id);
    result.topics_upserted = topicRows.length;

    // [2/7] Employers (one per unique domain; dedup by normalized_name).
    log('[2/7] employers');
    // internal is an override property; applies to every domain we know of.
    const domainToInternal = new Map<string, boolean>();
    for (const d of uniqueDomains) {
      domainToInternal.set(d, domainMap.get(d)?.internal ?? false);
    }

    // Resolve-once (RFC §6): domains mapped in a prior run reuse their stable
    // employer_id; we only resolve + create employers for unseen domains.
    const domainToEmployerId = new Map<string, string>();
    for (const d of uniqueDomains) {
      const existing = persistedDomainToEmployerId.get(d);
      if (existing) domainToEmployerId.set(d, existing);
    }
    const newDomains = [...uniqueDomains].filter(
      (d) => !domainToEmployerId.has(d),
    );

    const resolvedByDomain = new Map<string, ResolvedEmployer>();
    const employerValues: Array<{
      name: string;
      normalized_name: string;
      industry: string | null;
    }> = [];
    for (const d of newDomains) {
      const r = resolveEmployer(d, domainMap, classifiedByDomain);
      resolvedByDomain.set(d, r);
      employerValues.push({
        name: r.name,
        normalized_name: normalize(r.name),
        industry: r.industry,
      });
    }
    // Dedupe by normalized_name, preferring values with industry.
    const byNorm = new Map<string, (typeof employerValues)[number]>();
    for (const v of employerValues) {
      const prev = byNorm.get(v.normalized_name);
      if (!prev || (v.industry && !prev.industry)) byNorm.set(v.normalized_name, v);
    }
    const deduped = [...byNorm.values()];
    const employerRows = deduped.length
      ? await txEmployerRepo.upsertBatch(
          deduped.map((v) => ({
            name: v.name,
            normalized_name: v.normalized_name,
            industry: v.industry,
            status: 'inbound',
            curation_status: 'published',
          })),
        )
      : [];
    const normToEmployerId = new Map(
      employerRows.map((r) => [r.normalized_name, r.id]),
    );
    for (const d of newDomains) {
      const resolved = resolvedByDomain.get(d);
      const id = resolved && normToEmployerId.get(normalize(resolved.name));
      if (id) domainToEmployerId.set(d, id);
    }
    result.employers_upserted = employerRows.length;

    // Persist newly-resolved mappings so the next run reuses these ids.
    const txEmployerDomainRepo = new EmployerDomainRepository(txClient);
    const newMappings = newDomains
      .filter((d) => domainToEmployerId.has(d))
      .map((d) => ({
        domain: d,
        employer_id: domainToEmployerId.get(d) as string,
        source: 'auto',
      }));
    await txEmployerDomainRepo.persistMany(newMappings);

    // [3/7] Correspondents.
    log('[3/7] correspondents');
    const allParticipantEmails = new Map<
      string,
      { name: string; domain: string }
    >();
    for (const r of rowsToIngest) {
      if (r.from_address && !isExcluded(r.from_address)) {
        allParticipantEmails.set(r.from_address.toLowerCase(), {
          name: r.from_display_name ?? '',
          domain: domainOf(r.from_address),
        });
      }
      for (const addr of [
        ...(r.to_addresses ?? []),
        ...(r.cc_addresses ?? []),
      ]) {
        if (!addr || isExcluded(addr)) continue;
        const key = addr.toLowerCase();
        if (!allParticipantEmails.has(key)) {
          allParticipantEmails.set(key, { name: '', domain: domainOf(addr) });
        }
      }
    }
    const corrRows: Array<{
      employer_id: string;
      email: string;
      name: string;
      title: string | null;
      phone: string | null;
      type: 'internal' | 'external';
      source: string;
    }> = [];
    for (const [email, meta] of allParticipantEmails) {
      const employerId = domainToEmployerId.get(meta.domain);
      if (!employerId) continue;
      const enrichPerson = personByEmail.get(email);
      const internal = domainToInternal.get(meta.domain) ?? false;
      corrRows.push({
        employer_id: employerId,
        email,
        name: enrichPerson?.name || meta.name || email,
        title: enrichPerson?.role ?? null,
        phone: enrichPerson?.phone ?? null,
        type: internal ? 'internal' : 'external',
        source: 'mbox',
      });
    }
    const correspondentRows = await txCorrespondentRepo.upsertBatch(corrRows);
    const emailToCorrId = new Map<string, string>();
    for (const r of correspondentRows) {
      if (r.email) emailToCorrId.set(r.email.toLowerCase(), r.id);
    }
    result.correspondents_upserted = correspondentRows.length;

    // [4/7] Emails.
    log('[4/7] emails');
    const emailInserts: Array<{
      message_id: string | null;
      employer_id: string | null;
      from_address: string;
      from_display_name: string | null;
      subject: string | null;
      body_text: string | null;
      sent_at: string;
      direction: string;
      filter_status: string;
      processed_at: string;
      in_reply_to: string | null;
    }> = [];
    for (const r of rowsToIngest) {
      const senderEmail = (r.from_address ?? '').toLowerCase();
      const senderDomain = domainOf(senderEmail);
      const employerId = domainToEmployerId.get(senderDomain) ?? null;
      const internal = domainToInternal.get(senderDomain) ?? false;
      emailInserts.push({
        message_id: r.message_id || null,
        employer_id: employerId,
        from_address: senderEmail,
        from_display_name: r.from_display_name || null,
        subject: r.subject || null,
        body_text: r.body_text || null,
        sent_at: r.sent_at ?? new Date().toISOString(),
        direction: internal ? 'outbound' : 'inbound',
        filter_status: 'processed',
        processed_at: new Date().toISOString(),
        in_reply_to: r.in_reply_to || null,
      });
    }
    const insertedEmails = await txEmailRepo.insertBatchIgnoringDupes(
      emailInserts,
    );
    result.emails_inserted = insertedEmails.length;
    result.emails_skipped_dupe = emailInserts.length - insertedEmails.length;

    const midToEmailId = new Map<string, string>();
    for (const e of insertedEmails) {
      if (e.message_id) midToEmailId.set(e.message_id, e.id);
    }

    // [5/7] Email participants — only for emails we actually just inserted.
    log('[5/7] participants');
    const partRows: Array<{
      email_id: string;
      correspondent_id: string | null;
      address: string;
      display_name: string | null;
      role: 'from' | 'to' | 'cc';
    }> = [];
    for (const r of rowsToIngest) {
      const emailId = midToEmailId.get(r.message_id);
      if (!emailId) continue;
      if (r.from_address && !isExcluded(r.from_address)) {
        partRows.push({
          email_id: emailId,
          correspondent_id: emailToCorrId.get(r.from_address.toLowerCase()) ?? null,
          address: r.from_address.toLowerCase(),
          display_name: r.from_display_name || null,
          role: 'from',
        });
      }
      for (const addr of r.to_addresses ?? []) {
        if (isExcluded(addr)) continue;
        partRows.push({
          email_id: emailId,
          correspondent_id: emailToCorrId.get(addr.toLowerCase()) ?? null,
          address: addr.toLowerCase(),
          display_name: null,
          role: 'to',
        });
      }
      for (const addr of r.cc_addresses ?? []) {
        if (isExcluded(addr)) continue;
        partRows.push({
          email_id: emailId,
          correspondent_id: emailToCorrId.get(addr.toLowerCase()) ?? null,
          address: addr.toLowerCase(),
          display_name: null,
          role: 'cc',
        });
      }
    }
    const insertedParts = await txEmailRepo.insertParticipantsBatch(partRows);
    result.participants_inserted = insertedParts.length;

    // [6/7] Email topics.
    log('[6/7] email_topics');
    const etRows: Array<{ email_id: string; topic_id: string }> = [];
    for (const r of rowsToIngest) {
      const emailId = midToEmailId.get(r.message_id);
      if (!emailId) continue;
      const enrichRec = enrichmentByRawId.get(r.id);
      if (!enrichRec) continue;
      for (const t of (enrichRec.topics as string[] | null) ?? []) {
        const slug = normalize(t);
        if (!slug) continue;
        const topicId = slugToTopicId.get(slug);
        if (topicId) etRows.push({ email_id: emailId, topic_id: topicId });
      }
    }
    const insertedTopics = await txEmailRepo.insertTopicsBatch(etRows);
    result.email_topics_inserted = insertedTopics.length;

    // [7/7] employer_topics — derived aggregation.
    log('[7/7] employer_topics');
    const employerTopicRows = (await tx.execute(sql`
      INSERT INTO employer_topics (employer_id, topic_id, source)
      SELECT DISTINCT e.employer_id, et.topic_id, 'auto'
      FROM analytics.emails e
      JOIN analytics.email_topics et ON et.email_id = e.id
      WHERE e.employer_id IS NOT NULL
      ON CONFLICT (employer_id, topic_id) DO NOTHING
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    result.employer_topics_inserted = Array.isArray(employerTopicRows)
      ? employerTopicRows.length
      : 0;

    // Mark ingested.
    log('marking raw_emails ingested');
    await tx
      .update(rawEmailsTable)
      .set({ ingest_status: 'ingested', ingested_at: new Date().toISOString() })
      .where(
        inArray(
          rawEmailsTable.id,
          rowsToIngest.map((r) => r.id),
        ),
      );
    result.rows_ingested = rowsToIngest.length;
  });

  // Marts are precomputed read models over analytics.emails — keep them in step
  // with the data just ingested. Runs OUTSIDE the tx above (REFRESH …
  // CONCURRENTLY cannot run inside a transaction) and after it has committed, so
  // a missing/failed mart never invalidates the durable ingest. refreshAll
  // swallows per-mart errors and reports only the ones that refreshed.
  log('refreshing analytics marts');
  result.marts_refreshed = await new MartRepository(deps.db).refreshAll();

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
