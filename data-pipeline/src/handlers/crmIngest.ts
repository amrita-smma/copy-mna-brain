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
  CompanyRepository,
  CorrespondentRepository,
  EmailRepository,
  EmployerDomainRepository,
  EmployerOverrideRepository,
  EmployerRepository,
  EmployerRelatedCompanyRepository,
  EmployerTeamRepository,
  TopicRepository,
  UserWorkspaceRepository,
  WorkspaceCorrespondentRepository,
  UserRepository,
} from '@/lib/repositories';
import { loadCompanyIndex, matchRelatedCompany, normalizeCompanyName } from '../helpers/matchRelatedCompany';
import type { CompanyRow } from '../helpers/matchRelatedCompany';
import type { DbClient, Tables } from '@/lib/repositories';
import { getActiveWorkspaceId } from '@/lib/workspace';
import type { EnrichedPerson } from '../mboxParser';
import { INTERNAL_MAIL_DOMAINS } from './crmDomainClassify';

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
  team_members_inserted: number;
  related_companies_evidence_inserted: number;
  /** Analytics marts refreshed after this ingest (RFC MB-205 §Phase 5). */
  marts_refreshed: string[];
}

const log = (msg: string) => console.log(`[crm-ingest] ${msg}`);

interface DomainEntry {
  name: string;
  industry?: string | null;
}
interface DomainConfig {
  map: Map<string, DomainEntry>;
  excluded: Set<string>;
}

// MB-205: curated employer name/industry come from the `employer_overrides`
// table (curatable in-app), not scripts/domains.json. `excluded` rows build the
// drop-set. Internal-domain determination is INTERNAL_MAIL_DOMAINS (see
// crmDomainClassify.ts) only — employer_overrides.internal is no longer read.
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
      map.set(domain, { name: r.employer_name, industry: r.industry });
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
    return { name: curated.name, industry };
  }

  if (trustCls && cls?.name) {
    return { name: cls.name, industry: cls.industry ?? null };
  }

  // Fallback: titlecase the first label of the domain.
  const first = (domain.split('.')[0] || domain).toLowerCase();
  return {
    name: first.charAt(0).toUpperCase() + first.slice(1),
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
  const relatedCompanyRepo = new EmployerRelatedCompanyRepository(deps.db);

  // Default company-matching context for rows with no resolvable custodian
  // (no custodian_email, or a custodian not synced to any workspace) — same
  // fallback the attachment pipeline uses in resolveTargetWorkspaceIds when
  // findWorkspaceIdsBySyncedEmail comes back empty.
  const defaultWorkspaceId = await getActiveWorkspaceId();
  const defaultCompanyRepo = new CompanyRepository(deps.db, defaultWorkspaceId);
  const defaultCompanyIndex = await loadCompanyIndex(defaultCompanyRepo);

  const userWorkspaceRepo = new UserWorkspaceRepository(deps.db);
  const workspaceIdsByCustodian = new Map<string, string[]>();
  const companyContextByWorkspace = new Map<
    string,
    { repo: CompanyRepository; index: CompanyRow[] }
  >();
  companyContextByWorkspace.set(defaultWorkspaceId, {
    repo: defaultCompanyRepo,
    index: defaultCompanyIndex,
  });

  /**
   * All workspaces this raw email is relevant to, fanned out by
   * user_workspaces.is_email_synced — exactly like the attachment
   * pipeline's resolveTargetWorkspaceIds. Falls back to the default
   * workspace when the custodian is missing or not synced to any workspace.
   * Cached per custodian for the duration of this ingest run.
   */
  async function resolveWorkspaceIdsForCustodian(
    custodianEmail: string | null,
  ): Promise<string[]> {
    if (!custodianEmail) return [defaultWorkspaceId];
    let workspaceIds = workspaceIdsByCustodian.get(custodianEmail);
    if (workspaceIds === undefined) {
      workspaceIds = await userWorkspaceRepo.findWorkspaceIdsBySyncedEmail(custodianEmail);
      workspaceIdsByCustodian.set(custodianEmail, workspaceIds);
    }
    return workspaceIds.length > 0 ? workspaceIds : [defaultWorkspaceId];
  }

  /**
   * Company-matching context for one raw email's custodian mailbox. A
   * mailbox synced to more than one workspace matches against the first
   * resolved workspace only (primary, same convention as fileService.ts) —
   * employer_related_companies scopes by a single workspace_id now (see
   * 20260705000002_employer_related_companies_workspace_id.sql), so only the
   * primary workspace's company search space is used for matching.
   */
  async function resolveCompanyContext(
    custodianEmail: string | null,
  ): Promise<{ repo: CompanyRepository; index: CompanyRow[]; workspaceId: string }> {
    const workspaceIds = await resolveWorkspaceIdsForCustodian(custodianEmail);
    const primaryWorkspaceId = workspaceIds[0];
    let context = companyContextByWorkspace.get(primaryWorkspaceId);
    if (!context) {
      const repo = new CompanyRepository(deps.db, primaryWorkspaceId);
      const index = await loadCompanyIndex(repo);
      context = { repo, index };
      companyContextByWorkspace.set(primaryWorkspaceId, context);
    }
    return { ...context, workspaceId: primaryWorkspaceId };
  }

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
    team_members_inserted: 0,
    related_companies_evidence_inserted: 0,
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

  // Marts are precomputed read models over analytics.emails, but they also
  // reflect user_workspaces.is_email_synced (via analytics.email_workspace) —
  // a sync toggle with nothing new to ingest would otherwise never refresh
  // them. Runs OUTSIDE any transaction (REFRESH … CONCURRENTLY requirement)
  // and swallows per-mart errors, reporting only the ones that refreshed.
  const refreshMarts = async () => {
    log('refreshing analytics marts');
    result.marts_refreshed = await new MartRepository(deps.db).refreshAll();
  };

  log(`starting job=${deps.job.id} targets=${targets.length}`);
  if (targets.length === 0) {
    log('nothing to ingest');
    await refreshMarts();
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

  // Mark excluded rows terminal so the drain never re-fetches them. Without
  // this they stay ingest_status='pending' forever and reappear every run.
  const excludedIds = targets
    .filter((r) => isExcluded(r.from_address))
    .map((r) => r.id);
  if (excludedIds.length > 0) {
    await deps.db
      .update(rawEmailsTable)
      .set({ ingest_status: 'filtered' })
      .where(inArray(rawEmailsTable.id, excludedIds));
  }

  if (rowsToIngest.length === 0) {
    log('all targets excluded by domain');
    await refreshMarts();
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

  // 5. Unique topics across enrichments. Tolerates both old string[] and new
  // {name, is_deal_related}[] formats in raw_email_enrichments.topics (jsonb).
  type RawTopic = string | { name: string; is_deal_related: boolean };
  const uniqueTopics = new Map<string, { slug: string; is_deal_related: boolean }>();
  for (const e of enrichments) {
    for (const t of (e.topics as RawTopic[] | null) ?? []) {
      const raw = typeof t === 'string' ? t : t.name;
      const slug = normalize(raw);
      if (!slug) continue;
      if (!uniqueTopics.has(slug)) {
        uniqueTopics.set(slug, {
          slug,
          is_deal_related: typeof t === 'string' ? false : t.is_deal_related,
        });
      }
    }
  }

  log(
    `ingest set: ${rowsToIngest.length} emails / ${uniqueDomains.size} domains / ${uniqueTopics.size} topics`,
  );

  // Hoisted so the related-companies step (outside the tx) can read them.
  const midToEmailId = new Map<string, string>();
  const domainToEmployerId = new Map<string, string>();

  // Pre-warm the custodian->workspace cache via the OUTER db connection,
  // before opening the transaction below. resolveWorkspaceIdsForCustodian is
  // called again inside the tx (for the per-email correspondent membership
  // fan-out) — if that cache were still cold there, it would issue a query
  // through the outer `deps.db` pool from inside an active transaction,
  // which can deadlock: the transaction holds the pool's only connection
  // while waiting for a second connection to service that query. Warming the
  // cache here means every lookup made *inside* the transaction is a pure
  // in-memory hit, never touching the pool.
  const uniqueCustodianEmails = new Set(
    rowsToIngest
      .map((r) => r.custodian_email)
      .filter((e): e is string => !!e),
  );
  for (const custodianEmail of uniqueCustodianEmails) {
    await resolveWorkspaceIdsForCustodian(custodianEmail);
  }

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
    const txWorkspaceCorrespondentRepo = new WorkspaceCorrespondentRepository(txClient);
    const txEmployerTeamRepo = new EmployerTeamRepository(txClient);
    const txUserRepo = new UserRepository(txClient);

    // [1/7] Topics.
    log('[1/7] topics');
    const topicRows = await txTopicRepo.upsertBatch([...uniqueTopics.values()]);
    const slugToTopicId = new Map<string, string>();
    for (const t of topicRows) slugToTopicId.set(t.slug, t.id);
    result.topics_upserted = topicRows.length;

    // [2/7] Employers (one per unique domain; dedup by normalized_name).
    log('[2/7] employers');
    // internal comes solely from the hardcoded list — see INTERNAL_MAIL_DOMAINS
    // for why employer_overrides.internal is no longer read.
    const domainToInternal = new Map<string, boolean>();
    for (const d of uniqueDomains) {
      domainToInternal.set(d, INTERNAL_MAIL_DOMAINS.has(d));
    }

    // Resolve-once (RFC §6): domains mapped in a prior run reuse their stable
    // employer_id; we only resolve + create employers for unseen domains.
    // Domains later flipped to `internal` must drop any stale persisted
    // mapping too, or they keep resolving to their old employer_id forever.
    for (const d of uniqueDomains) {
      if (domainToInternal.get(d)) continue;
      const existing = persistedDomainToEmployerId.get(d);
      if (existing) domainToEmployerId.set(d, existing);
    }
    const newDomains = [...uniqueDomains].filter(
      (d) => !domainToEmployerId.has(d) && !domainToInternal.get(d),
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

    // Resolve internal recipients and mailbox custodians to application users.
    // The resulting map is reused for email_participants.user_id and employer
    // team coverage below. Addresses are normalized because email matching is
    // case-insensitive while the users.email unique constraint is not.
    const possibleUserEmails = new Set<string>();
    for (const r of rowsToIngest) {
      for (const address of [
        r.from_address,
        r.custodian_email,
        ...(r.to_addresses ?? []),
        ...(r.cc_addresses ?? []),
      ]) {
        const normalized = address?.trim().toLowerCase();
        if (normalized) possibleUserEmails.add(normalized);
      }
    }
    const matchedUsers = await txUserRepo.findByEmails([...possibleUserEmails]);
    const userIdByEmail = new Map(
      matchedUsers
        .filter((user): user is typeof user & { email: string } => !!user.email)
        .map((user) => [user.email.trim().toLowerCase(), user.id]),
    );

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

    for (const e of insertedEmails) {
      if (e.message_id) midToEmailId.set(e.message_id, e.id);
    }

    // A message_id already ingested in a PRIOR run (e.g. the same email
    // reaching a different custodian's mailbox later) is skipped by
    // insertBatchIgnoringDupes and so is absent from insertedEmails/
    // midToEmailId above. Without this backfill, the [5/7] loop below would
    // silently drop workspace_correspondents membership for that later
    // custodian's workspace — the contact was really seen there, but never
    // gets marked visible. Mirrors the same backfill [8] related_companies
    // already does for the same reason.
    const missingMessageIdsForParticipants = rowsToIngest
      .map((r) => r.message_id)
      .filter((mid): mid is string => !!mid && !midToEmailId.has(mid));
    if (missingMessageIdsForParticipants.length > 0) {
      const existingEmailsForParticipants = await tx
        .select({ id: emailsTable.id, message_id: emailsTable.message_id })
        .from(emailsTable)
        .where(inArray(emailsTable.message_id, missingMessageIdsForParticipants));
      for (const e of existingEmailsForParticipants) {
        if (e.message_id) midToEmailId.set(e.message_id, e.id);
      }
    }

    // [5/7] Email participants — only for emails we actually just inserted.
    log('[5/7] participants');
    const partRows: Array<{
      email_id: string;
      user_id: string | null;
      correspondent_id: string | null;
      address: string;
      display_name: string | null;
      role: 'from' | 'to' | 'cc';
    }> = [];
    // Correspondent visibility fan-out: attached per-email (not after this
    // whole batch upsert) so a contact only becomes visible to the
    // workspace(s) whose custodian mailbox actually surfaced it in *this*
    // email — attaching post-batch would let one email's custodian bleed
    // visibility onto every other correspondent in the same ingest run.
    const membershipPairs: Array<{ workspaceId: string; correspondentId: string; source: 'ingest' }> = [];
    const addMembershipPairs = async (correspondentId: string | null, custodianEmail: string | null) => {
      if (!correspondentId) return;
      const workspaceIds = await resolveWorkspaceIdsForCustodian(custodianEmail);
      for (const workspaceId of workspaceIds) {
        membershipPairs.push({ workspaceId, correspondentId, source: 'ingest' });
      }
    };
    for (const r of rowsToIngest) {
      const emailId = midToEmailId.get(r.message_id);
      if (!emailId) continue;
      if (r.from_address && !isExcluded(r.from_address)) {
        const correspondentId = emailToCorrId.get(r.from_address.toLowerCase()) ?? null;
        partRows.push({
          email_id: emailId,
          user_id: userIdByEmail.get(r.from_address.toLowerCase()) ?? null,
          correspondent_id: correspondentId,
          address: r.from_address.toLowerCase(),
          display_name: r.from_display_name || null,
          role: 'from',
        });
        await addMembershipPairs(correspondentId, r.custodian_email);
      }
      for (const addr of r.to_addresses ?? []) {
        if (isExcluded(addr)) continue;
        const correspondentId = emailToCorrId.get(addr.toLowerCase()) ?? null;
        partRows.push({
          email_id: emailId,
          user_id: userIdByEmail.get(addr.toLowerCase()) ?? null,
          correspondent_id: correspondentId,
          address: addr.toLowerCase(),
          display_name: null,
          role: 'to',
        });
        await addMembershipPairs(correspondentId, r.custodian_email);
      }
      for (const addr of r.cc_addresses ?? []) {
        if (isExcluded(addr)) continue;
        const correspondentId = emailToCorrId.get(addr.toLowerCase()) ?? null;
        partRows.push({
          email_id: emailId,
          user_id: userIdByEmail.get(addr.toLowerCase()) ?? null,
          correspondent_id: correspondentId,
          address: addr.toLowerCase(),
          display_name: null,
          role: 'cc',
        });
        await addMembershipPairs(correspondentId, r.custodian_email);
      }
    }
    const insertedParts = await txEmailRepo.insertParticipantsBatch(partRows);
    result.participants_inserted = insertedParts.length;
    await txWorkspaceCorrespondentRepo.addMemberships(membershipPairs);

    // [6/7] Email topics.
    log('[6/7] email_topics');
    const etRows: Array<{ email_id: string; topic_id: string }> = [];
    for (const r of rowsToIngest) {
      const emailId = midToEmailId.get(r.message_id);
      if (!emailId) continue;
      const enrichRec = enrichmentByRawId.get(r.id);
      if (!enrichRec) continue;
      for (const t of (enrichRec.topics as RawTopic[] | null) ?? []) {
        const raw = typeof t === 'string' ? t : t.name;
        const slug = normalize(raw);
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

    // A user covers the external counterparty when that user is a To/CC
    // recipient or the Vault mailbox custodian. For inbound mail the
    // counterparty is the sender; for outbound mail it is every external
    // To/CC domain. Multiple users may cover one employer; addMany preserves
    // all existing manual/seed assignments via ON CONFLICT DO NOTHING.
    const teamAssignments: Array<{ employer_id: string; user_id: string }> = [];
    for (const r of rowsToIngest) {
      const userIds = new Set<string>();
      for (const address of [
        r.custodian_email,
        ...(r.to_addresses ?? []),
        ...(r.cc_addresses ?? []),
      ]) {
        const userId = address
          ? userIdByEmail.get(address.trim().toLowerCase())
          : undefined;
        if (userId) userIds.add(userId);
      }
      if (userIds.size === 0) continue;

      const senderEmail = r.from_address?.trim().toLowerCase() ?? '';
      const senderDomain = domainOf(senderEmail);
      const senderIsInternal =
        !!domainToInternal.get(senderDomain) || userIdByEmail.has(senderEmail);
      const counterpartyAddresses = senderIsInternal
        ? [...(r.to_addresses ?? []), ...(r.cc_addresses ?? [])]
        : [r.from_address];

      const employerIds = new Set<string>();
      for (const address of counterpartyAddresses) {
        const domain = domainOf(address ?? '');
        if (
          !domain ||
          excludedDomains.has(domain) ||
          domainToInternal.get(domain)
        ) {
          continue;
        }
        const employerId = domainToEmployerId.get(domain);
        if (employerId) employerIds.add(employerId);
      }

      for (const employer_id of employerIds) {
        for (const user_id of userIds) {
          teamAssignments.push({ employer_id, user_id });
        }
      }
    }
    result.team_members_inserted = await txEmployerTeamRepo.addMany(
      teamAssignments,
    );

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

  // Related companies — runs OUTSIDE the main tx for the same reason marts do:
  // it makes many small round-trips (upsertAuto, insertEvidence, refreshAggregates)
  // that would hold the main transaction's locks unnecessarily long. midToEmailId
  // is already populated from the committed inserts above.
  log('[8] related_companies');
  log(`[8] default company index loaded: ${defaultCompanyIndex.length} companies`);

  // On re-ingest (rawEmailIds path), emails already exist in analytics.emails so
  // insertBatchIgnoringDupes skips them and they never land in midToEmailId. Fall
  // back to a DB lookup for any message_id not already resolved.
  const missingMessageIds = rowsToIngest
    .map((r) => r.message_id)
    .filter((mid): mid is string => !!mid && !midToEmailId.has(mid));
  if (missingMessageIds.length > 0) {
    const existingEmails = await deps.db
      .select({ id: emailsTable.id, message_id: emailsTable.message_id })
      .from(emailsTable)
      .where(inArray(emailsTable.message_id, missingMessageIds));
    for (const e of existingEmails) {
      if (e.message_id) midToEmailId.set(e.message_id, e.id);
    }
  }

  const affectedRelatedCompanyIds = new Set<string>();
  let rcEmailsProcessed = 0;
  for (const r of rowsToIngest) {
    const emailId = midToEmailId.get(r.message_id);
    if (!emailId) continue;
    const enrichRec = enrichmentByRawId.get(r.id);
    if (!enrichRec) continue;
    const relatedCompanies = (enrichRec.related_companies as import('../mboxParser').LlmRelatedCompany[] | null) ?? [];
    if (relatedCompanies.length === 0) continue;

    const senderDomain = domainOf(r.from_address ?? '');
    const employerId = domainToEmployerId.get(senderDomain);
    if (!employerId) continue;

    rcEmailsProcessed++;
    const { repo: companyRepoForRow, index: companyIndexForRow, workspaceId: rowWorkspaceId } =
      await resolveCompanyContext(r.custodian_email);
    for (const rc of relatedCompanies) {
      if (!rc.company_name?.trim()) continue;
      try {
        const companyId = await matchRelatedCompany(rc.company_name, companyRepoForRow, companyIndexForRow);
        const normalizedName = normalizeCompanyName(rc.company_name);
        const relatedCompanyId = await relatedCompanyRepo.upsertAuto({
          employer_id: employerId,
          workspace_id: rowWorkspaceId,
          company_id: companyId,
          company_name: rc.company_name,
          normalized_company_name: normalizedName,
          source: 'auto',
          reason: rc.reason,
          reason_summary: rc.reason_summary ?? null,
        });
        await relatedCompanyRepo.insertEvidence({
          related_company_id: relatedCompanyId,
          email_id: emailId,
          raw_email_id: r.id,
          matched_text: rc.matched_text ?? null,
          reason: rc.reason,
          reason_summary: rc.reason_summary ?? null,
          keywords: rc.keywords ?? [],
          confidence: rc.confidence,
        });
        affectedRelatedCompanyIds.add(relatedCompanyId);
        result.related_companies_evidence_inserted++;
        log(`[8] "${rc.company_name}" (${rc.confidence}) from ${senderDomain} → ${companyId ? 'matched' : 'free-text'}`);
      } catch (err) {
        console.error(`[crm-ingest] related company ${rc.company_name} for raw_email ${r.id} failed:`, err);
      }
    }
  }
  log(`[8] emails with related companies: ${rcEmailsProcessed}, evidence inserted: ${result.related_companies_evidence_inserted}, aggregates to refresh: ${affectedRelatedCompanyIds.size}`);
  for (const id of affectedRelatedCompanyIds) {
    await relatedCompanyRepo.refreshAggregates(id);
  }
  log(`[8] related_companies done`);

  // Runs OUTSIDE the tx above (REFRESH … CONCURRENTLY cannot run inside a
  // transaction) and after it has committed, so a missing/failed mart never
  // invalidates the durable ingest.
  await refreshMarts();

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
