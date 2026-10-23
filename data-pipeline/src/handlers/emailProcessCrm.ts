/**
 * CRM upsert helpers for the ephemeral email processor.
 * Mirrors the durable writes from crmIngest without raw_emails staging.
 *
 * All durable writes run in a single transaction so a mid-batch failure cannot
 * leave analytics.emails rows that flushBatch would then treat as "done"
 * (skipping participants / topics / Smart Files forever).
 */

import { sql } from 'drizzle-orm';
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
  UserRepository,
  UserWorkspaceRepository,
  WorkspaceCorrespondentRepository,
} from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import {
  loadCompanyIndex,
  matchRelatedCompany,
  normalizeCompanyName,
} from '../helpers/matchRelatedCompany';
import {
  INTERNAL_MAIL_DOMAINS,
  PERSONAL_MAIL_DOMAINS,
} from '../lib/mailDomains';
import { pickBetterContactName } from '@/lib/crm/contactName';
import type {
  EnrichedPerson,
  LlmExtraction,
  LlmRelatedCompany,
} from '../mboxParser';
import { mergePeopleWithCandidates, type Candidate } from '../mboxParser';
import {
  externalAddresses,
  sanitizeEmailNote,
  type LlmEmailNote,
} from '../mboxParser/llmEnrich';

export interface EphemeralCrmMessage {
  message_id: string;
  from_address: string;
  from_display_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string | null;
  sent_at: string;
  in_reply_to: string | null;
  custodian_email: string;
  direction: 'inbound' | 'outbound';
  candidates: Candidate[];
  llm: LlmExtraction | null;
  model?: string;
}

function domainOf(email: string): string {
  const i = email.indexOf('@');
  return i === -1 ? '' : email.slice(i + 1).toLowerCase();
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');
}

/** Skip creating employer/correspondent cards (crmIngest parity). */
export function skipCrmPerson(
  email: string,
  excludedDomains: Set<string>,
): boolean {
  const domain = domainOf(email);
  return (
    !domain ||
    excludedDomains.has(domain) ||
    INTERNAL_MAIL_DOMAINS.has(domain) ||
    PERSONAL_MAIL_DOMAINS.has(domain)
  );
}

export function skipEmployerDomain(
  domain: string,
  excludedDomains: Set<string>,
): boolean {
  return (
    !domain ||
    excludedDomains.has(domain) ||
    INTERNAL_MAIL_DOMAINS.has(domain) ||
    PERSONAL_MAIL_DOMAINS.has(domain)
  );
}

const MAX_LLM_COMPANY_LENGTH = 120;

function cleanLlmCompany(company: string | null | undefined): string | null {
  const c = (company ?? '').replace(/\s+/g, ' ').trim();
  if (!c || c.includes('@') || c.length > MAX_LLM_COMPANY_LENGTH) return null;
  return normalize(c) ? c : null;
}

/**
 * For each email domain, the company name the LLM most often attributes to
 * people at that domain in this batch. Ties go to the value seen first.
 * `peopleByMessage` is the merged LLM people list of every message.
 */
export function llmCompanyByDomain(
  peopleByMessage: EnrichedPerson[][],
): Map<string, string> {
  const counts = new Map<string, Map<string, { name: string; n: number; order: number }>>();
  let order = 0;
  for (const people of peopleByMessage) {
    for (const p of people) {
      if (!p.email) continue;
      const domain = domainOf(p.email);
      const company = cleanLlmCompany(p.company);
      if (!domain || !company) continue;
      let byNorm = counts.get(domain);
      if (!byNorm) {
        byNorm = new Map();
        counts.set(domain, byNorm);
      }
      const key = normalize(company);
      const hit = byNorm.get(key);
      if (hit) hit.n += 1;
      else byNorm.set(key, { name: company, n: 1, order: order++ });
    }
  }
  const out = new Map<string, string>();
  for (const [domain, byNorm] of counts) {
    let best: { name: string; n: number; order: number } | null = null;
    for (const c of byNorm.values()) {
      if (!best || c.n > best.n || (c.n === best.n && c.order < best.order)) {
        best = c;
      }
    }
    if (best) out.set(domain, best.name);
  }
  return out;
}

export interface CorrespondentCandidate {
  employer_id: string;
  email: string;
  name: string;
  title: string | null;
  phone: string | null;
  type: 'internal' | 'external';
  source: string;
}

/**
 * One correspondent row per address across the batch. When an address is seen
 * more than once, the best name wins (`pickBetterContactName`: a real name
 * beats an address-like one, the first real name is kept) and title/phone keep
 * the first non-null value.
 */
export function collectCorrespondentCandidates(
  messages: Pick<
    EphemeralCrmMessage,
    'from_address' | 'from_display_name' | 'to_addresses' | 'cc_addresses'
  >[],
  peopleByMessage: EnrichedPerson[][],
  domainToEmployerId: Map<string, string>,
  excludedDomains: Set<string>,
): Map<string, CorrespondentCandidate> {
  const corrByEmail = new Map<string, CorrespondentCandidate>();
  messages.forEach((m, i) => {
    const people = peopleByMessage[i] ?? [];
    const byEmail = new Map(
      people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]),
    );
    const sender = (m.from_address ?? '').toLowerCase();
    for (const addr of [m.from_address, ...m.to_addresses, ...m.cc_addresses]) {
      if (!addr || skipCrmPerson(addr, excludedDomains)) continue;
      const employerId = domainToEmployerId.get(domainOf(addr));
      if (!employerId) continue;
      const key = addr.toLowerCase();
      const person = byEmail.get(key);
      const name = pickBetterContactName(
        person?.name,
        key === sender ? m.from_display_name : null,
        key,
      );
      const prev = corrByEmail.get(key);
      if (!prev) {
        corrByEmail.set(key, {
          employer_id: employerId,
          email: key,
          name,
          title: person?.role ?? null,
          phone: person?.phone ?? null,
          type: 'external',
          source: 'mbox',
        });
        continue;
      }
      prev.name = pickBetterContactName(prev.name, name, key);
      prev.title = prev.title ?? person?.role ?? null;
      prev.phone = prev.phone ?? person?.phone ?? null;
    }
  });
  return corrByEmail;
}

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

export interface EphemeralCrmResult {
  emails_inserted: number;
  topics_upserted: number;
  employers_upserted: number;
  correspondents_upserted: number;
  participants_inserted: number;
  related_companies_evidence_inserted: number;
  team_members_inserted: number;
}

/** One email's sanitized note (null when the model returned none) and the model that wrote it. */
export type EmailNoteItem = {
  emailId: string;
  note: LlmEmailNote | null;
  model: string | null;
};

/**
 * Bulk-insert email notes and role signals for already-ingested or fresh emails.
 * One statement per table, ON CONFLICT DO NOTHING.
 */
export async function upsertEmailNotes(
  db: DbClient,
  items: EmailNoteItem[],
): Promise<void> {
  if (items.length === 0) return;

  await db.execute(sql`
    INSERT INTO analytics.email_notes (
      email_id, summary, key_points, next_step, next_step_status, sentiment, model
    )
    VALUES ${sql.join(
      items.map(
        ({ emailId, note, model }) =>
          sql`(${emailId}::uuid, ${note?.summary ?? null}, ${JSON.stringify(note?.key_points ?? [])}::jsonb, ${note?.next_step ?? null}, ${note?.next_step_status ?? 'none'}, ${note?.sentiment ?? 'neutral'}, ${model})`,
      ),
      sql`, `,
    )}
    ON CONFLICT (email_id) DO NOTHING
  `);

  const roles = items.flatMap(
    ({ emailId, note }) =>
      note?.counterparty_roles.map(
        (r) => sql`(${emailId}::uuid, ${r.address}, ${r.label}, ${r.confidence}, ${r.evidence})`,
      ) ?? [],
  );
  if (roles.length === 0) return;
  await db.execute(sql`
    INSERT INTO analytics.email_role_signals (
      email_id, address, label, confidence, evidence
    )
    VALUES ${sql.join(roles, sql`, `)}
    ON CONFLICT (email_id, address, label) DO NOTHING
  `);
}

/**
 * Bulk-insert email envelopes + topics/employers/correspondents/participants/
 * related-company evidence for a batch that already passed privacy + LLM gates.
 */
export async function upsertEphemeralCrmBatch(
  messages: EphemeralCrmMessage[],
  deps: { db: DbClient },
): Promise<EphemeralCrmResult> {
  const empty: EphemeralCrmResult = {
    emails_inserted: 0,
    topics_upserted: 0,
    employers_upserted: 0,
    correspondents_upserted: 0,
    participants_inserted: 0,
    related_companies_evidence_inserted: 0,
    team_members_inserted: 0,
  };
  if (messages.length === 0) return empty;

  // Warm reads outside the write transaction (same pool-deadlock avoidance as
  // crmIngest: nested lookups while holding a tx connection can stall).
  const overrideRepo = new EmployerOverrideRepository(deps.db);
  const employerDomainRepoWarm = new EmployerDomainRepository(deps.db);
  const userRepoWarm = new UserRepository(deps.db);
  const uwRepoWarm = new UserWorkspaceRepository(deps.db);

  const overrides = await overrideRepo.listAll();
  const domainName = new Map<string, string>();
  const excludedDomains = new Set<string>();
  for (const r of overrides) {
    const d = r.domain.toLowerCase();
    if (r.employer_name) domainName.set(d, r.employer_name);
    if (r.excluded) excludedDomains.add(d);
  }
  const persisted = await employerDomainRepoWarm.loadMap();

  const userEmails = new Set<string>();
  for (const m of messages) {
    for (const a of [
      m.custodian_email,
      m.from_address,
      ...m.to_addresses,
      ...m.cc_addresses,
    ]) {
      if (a) userEmails.add(a.toLowerCase());
    }
  }
  const matchedUsers = await userRepoWarm.findByEmails([...userEmails]);
  const userIdByEmail = new Map(
    matchedUsers
      .filter((u) => u.email)
      .map((u) => [u.email!.toLowerCase(), u.id]),
  );

  const wsCache = new Map<string, string[]>();
  async function warmWorkspaces(custodian: string): Promise<string[]> {
    const key = custodian.toLowerCase();
    if (wsCache.has(key)) return wsCache.get(key)!;
    const ids = await uwRepoWarm.findWorkspaceIdsBySyncedEmail(key);
    wsCache.set(key, ids);
    return ids;
  }
  for (const m of messages) {
    await warmWorkspaces(m.custodian_email);
  }

  const affectedRelatedCompanyIds = new Set<string>();
  const peopleByMessage = messages.map((m) =>
    mergePeopleWithCandidates(m.llm?.people ?? [], m.candidates),
  );

  const result = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as DbClient;
    const result: EphemeralCrmResult = { ...empty };

    const emailRepo = new EmailRepository(db);
    const topicRepo = new TopicRepository(db);
    const employerRepo = new EmployerRepository(db);
    const employerDomainRepo = new EmployerDomainRepository(db);
    const correspondentRepo = new CorrespondentRepository(db);
    const relatedRepo = new EmployerRelatedCompanyRepository(db);
    const teamRepo = new EmployerTeamRepository(db);
    const wcRepo = new WorkspaceCorrespondentRepository(db);

    const topicMap = new Map<
      string,
      { slug: string; is_deal_related: boolean }
    >();
    for (const m of messages) {
      for (const t of m.llm?.topics ?? []) {
        const slug = normalize(t.name);
        if (!slug) continue;
        if (!topicMap.has(slug)) {
          topicMap.set(slug, { slug, is_deal_related: !!t.is_deal_related });
        }
      }
    }
    const topicRows = await topicRepo.upsertBatch([...topicMap.values()]);
    const slugToTopicId = new Map(topicRows.map((t) => [t.slug, t.id]));
    result.topics_upserted = topicRows.length;

    const domainToEmployerId = new Map<string, string>();
    const newDomains: string[] = [];
    for (const m of messages) {
      for (const addr of [
        m.from_address,
        ...m.to_addresses,
        ...m.cc_addresses,
      ]) {
        const d = domainOf(addr);
        if (skipEmployerDomain(d, excludedDomains)) {
          continue;
        }
        if (persisted.has(d)) {
          domainToEmployerId.set(d, persisted.get(d)!);
          continue;
        }
        if (!domainToEmployerId.has(d)) newDomains.push(d);
      }
    }
    const uniqueNew = [...new Set(newDomains)];
    // A new domain's employer is named by its curated
    // `employer_overrides.employer_name`, else the company the LLM attributes
    // to the domain, else the capitalised domain label (`gs.com` → `Gs`).
    const llmByDomain = llmCompanyByDomain(peopleByMessage);
    const nameFor = (domain: string): string => {
      const label = (domain.split('.')[0] || domain).toLowerCase();
      return (
        domainName.get(domain) ??
        llmByDomain.get(domain) ??
        label.charAt(0).toUpperCase() + label.slice(1)
      );
    };
    // First name wins when two new domains' names normalise the same.
    const nameByNorm = new Map<string, string>();
    for (const d of uniqueNew) {
      const name = nameFor(d);
      if (!nameByNorm.has(normalize(name))) nameByNorm.set(normalize(name), name);
    }
    // A chosen name that already belongs to an employer links to that row
    // as-is: only genuinely new employers are inserted, so an existing
    // employer is never renamed by ingest.
    const normToId = new Map(
      (await employerRepo.findByNormalizedNames([...nameByNorm.keys()])).map(
        (e) => [e.normalized_name, e.id],
      ),
    );
    const employerRows = await employerRepo.upsertBatch(
      [...nameByNorm]
        .filter(([norm]) => !normToId.has(norm))
        .map(([normalized_name, name]) => ({
          name,
          normalized_name,
          industry: null,
          status: 'inbound',
          curation_status: 'published',
        })),
    );
    result.employers_upserted = employerRows.length;
    for (const r of employerRows) normToId.set(r.normalized_name, r.id);
    for (const d of uniqueNew) {
      const id = normToId.get(normalize(nameFor(d)));
      if (id) domainToEmployerId.set(d, id);
    }
    await employerDomainRepo.persistMany(
      uniqueNew
        .filter((d) => domainToEmployerId.has(d))
        .map((d) => ({
          domain: d,
          employer_id: domainToEmployerId.get(d)!,
          source: 'auto',
        })),
    );

    const emailInserts = messages.map((m) => {
      const senderDomain = domainOf(m.from_address);
      return {
        message_id: m.message_id,
        employer_id: domainToEmployerId.get(senderDomain) ?? null,
        from_address: m.from_address,
        from_display_name: m.from_display_name,
        sent_at: m.sent_at,
        direction: m.direction,
        filter_status: 'processed',
        processed_at: new Date().toISOString(),
        in_reply_to: m.in_reply_to,
        custodian_email: m.custodian_email,
      };
    });
    const inserted = await emailRepo.insertBatchIgnoringDupes(emailInserts);
    result.emails_inserted = inserted.length;
    const midToEmailId = new Map(
      inserted.filter((e) => e.message_id).map((e) => [e.message_id!, e.id]),
    );
    const missing = messages
      .map((m) => m.message_id)
      .filter((mid) => !midToEmailId.has(mid));
    if (missing.length > 0) {
      const existing = queryRows<{ id: string; message_id: string }>(
        await db.execute(sql`
          SELECT id, message_id FROM analytics.emails
          WHERE message_id IN (${sql.join(
            missing.map((m) => sql`${m}`),
            sql`, `,
          )})
        `),
      );
      for (const r of existing) {
        if (r.message_id) midToEmailId.set(r.message_id, r.id);
      }
    }

    const noteItems: EmailNoteItem[] = [];
    for (const m of messages) {
      const emailId = midToEmailId.get(m.message_id);
      if (!m.llm || !emailId) continue;
      noteItems.push({
        emailId,
        note: sanitizeEmailNote(
          m.llm.email_note,
          externalAddresses(m.from_address, m.to_addresses, m.cc_addresses),
        ),
        model: m.model ?? null,
      });
    }
    await upsertEmailNotes(db, noteItems);

    const corrByEmail = collectCorrespondentCandidates(
      messages,
      peopleByMessage,
      domainToEmployerId,
      excludedDomains,
    );
    // Email is the CRM join key: an address that already belongs to a contact
    // under a DIFFERENT employer (typically one a human added by hand under the
    // firm they chose) links to that contact instead of spawning a duplicate
    // under the domain-derived employer. Same-employer rows still go through
    // the upsert, which leaves origin='manual' rows untouched.
    const existingByEmail = new Map<string, { id: string; employer_id: string }>();
    for (const c of await correspondentRepo.findByEmails([...corrByEmail.keys()])) {
      const key = c.email?.toLowerCase();
      if (key && !existingByEmail.has(key)) existingByEmail.set(key, c);
    }
    const emailToCorrId = new Map<string, string>();
    const toUpsert = [...corrByEmail].flatMap(([key, row]) => {
      const existing = existingByEmail.get(key);
      if (existing && existing.employer_id !== row.employer_id) {
        emailToCorrId.set(key, existing.id);
        return [];
      }
      return [row];
    });
    const correspondentRows = await correspondentRepo.upsertBatch(toUpsert);
    result.correspondents_upserted = correspondentRows.length;
    for (const c of correspondentRows) {
      if (c.email) emailToCorrId.set(c.email.toLowerCase(), c.id);
    }

    const partRows: Array<{
      email_id: string;
      user_id: string | null;
      correspondent_id: string | null;
      address: string;
      display_name: string | null;
      role: 'from' | 'to' | 'cc';
    }> = [];
    const memberships: Array<{
      workspaceId: string;
      correspondentId: string;
      source: 'ingest';
    }> = [];

    for (const m of messages) {
      const emailId = midToEmailId.get(m.message_id);
      if (!emailId) continue;
      const pushPart = (
        addr: string,
        role: 'from' | 'to' | 'cc',
        display: string | null,
      ) => {
        const correspondentId = skipCrmPerson(addr, excludedDomains)
          ? null
          : (emailToCorrId.get(addr.toLowerCase()) ?? null);
        partRows.push({
          email_id: emailId,
          user_id: userIdByEmail.get(addr.toLowerCase()) ?? null,
          correspondent_id: correspondentId,
          address: addr.toLowerCase(),
          display_name: display,
          role,
        });
        if (correspondentId) {
          for (const workspaceId of wsCache.get(m.custodian_email.toLowerCase()) ??
            []) {
            memberships.push({
              workspaceId,
              correspondentId,
              source: 'ingest',
            });
          }
        }
      };
      if (m.from_address) {
        pushPart(m.from_address, 'from', m.from_display_name);
      }
      for (const a of m.to_addresses) pushPart(a, 'to', null);
      for (const a of m.cc_addresses) pushPart(a, 'cc', null);
    }
    const parts = await emailRepo.insertParticipantsBatch(partRows);
    result.participants_inserted = parts.length;
    await wcRepo.addMemberships(memberships);

    const etRows: Array<{ email_id: string; topic_id: string }> = [];
    for (const m of messages) {
      const emailId = midToEmailId.get(m.message_id);
      if (!emailId) continue;
      for (const t of m.llm?.topics ?? []) {
        const topicId = slugToTopicId.get(normalize(t.name));
        if (topicId) etRows.push({ email_id: emailId, topic_id: topicId });
      }
    }
    await emailRepo.insertTopicsBatch(etRows);

    // Firm tags are per workspace (MB-687): an email's auto tags land only in
    // the workspaces its custodian syncs into — the same wsCache that scopes
    // the contact memberships above — never in a workspace that cannot see
    // the email.
    const custodianWorkspaces = [
      ...new Set(messages.map((m) => m.custodian_email.toLowerCase())),
    ].flatMap((custodian) =>
      (wsCache.get(custodian) ?? []).map((workspaceId) => ({ custodian, workspaceId })),
    );
    if (custodianWorkspaces.length > 0) {
      await db.execute(sql`
        INSERT INTO employer_topics (workspace_id, employer_id, topic_id, source)
        SELECT DISTINCT cw.workspace_id, e.employer_id, et.topic_id, 'auto'
        FROM analytics.emails e
        JOIN analytics.email_topics et ON et.email_id = e.id
        JOIN (VALUES ${sql.join(
          custodianWorkspaces.map(
            (cw) => sql`(${cw.custodian}, ${cw.workspaceId}::uuid)`,
          ),
          sql`, `,
        )}) AS cw(custodian, workspace_id)
          ON cw.custodian = lower(e.custodian_email)
        WHERE e.employer_id IS NOT NULL
          AND e.message_id IN (${sql.join(
            messages.map((m) => sql`${m.message_id}`),
            sql`, `,
          )})
        ON CONFLICT (workspace_id, employer_id, topic_id) DO NOTHING
      `);
    }

    // Coverage is per workspace too: each assignment lands in every workspace
    // the email's custodian syncs into.
    const teamAssignments: Array<{
      workspace_id: string;
      employer_id: string;
      user_id: string;
    }> = [];
    for (const m of messages) {
      const userIds = new Set<string>();
      for (const a of [
        m.custodian_email,
        ...m.to_addresses,
        ...m.cc_addresses,
      ]) {
        const uid = userIdByEmail.get(a.toLowerCase());
        if (uid) userIds.add(uid);
      }
      if (userIds.size === 0) continue;
      const senderInternal = INTERNAL_MAIL_DOMAINS.has(
        domainOf(m.from_address),
      );
      const counterparty = senderInternal
        ? [...m.to_addresses, ...m.cc_addresses]
        : [m.from_address];
      const employerIds = new Set<string>();
      for (const a of counterparty) {
        const d = domainOf(a);
        if (skipEmployerDomain(d, excludedDomains)) {
          continue;
        }
        const eid = domainToEmployerId.get(d);
        if (eid) employerIds.add(eid);
      }
      const workspaceIds = wsCache.get(m.custodian_email.toLowerCase()) ?? [];
      for (const workspace_id of workspaceIds) {
        for (const employer_id of employerIds) {
          for (const user_id of userIds) {
            teamAssignments.push({ workspace_id, employer_id, user_id });
          }
        }
      }
    }
    result.team_members_inserted = await teamRepo.addMany(teamAssignments);

    const companyIndexByWs = new Map<
      string,
      Awaited<ReturnType<typeof loadCompanyIndex>>
    >();
    const companyRepoByWs = new Map<string, CompanyRepository>();
    let evidenceCount = 0;
    for (const m of messages) {
      const emailId = midToEmailId.get(m.message_id);
      if (!emailId || !m.llm?.related_companies?.length) continue;
      const senderDomain = domainOf(m.from_address);
      let employerId = domainToEmployerId.get(senderDomain);
      if (!employerId && m.direction === 'outbound') {
        employerId = [...m.to_addresses, ...m.cc_addresses]
          .map((a) => domainToEmployerId.get(domainOf(a)))
          .find((id): id is string => !!id);
      }
      if (!employerId) continue;

      const workspaceIds = wsCache.get(m.custodian_email.toLowerCase()) ?? [];

      for (const rc of m.llm.related_companies as LlmRelatedCompany[]) {
        const name = (rc.company_name ?? '').trim();
        if (!name) continue;
        for (const workspaceId of workspaceIds) {
          let companyRepo = companyRepoByWs.get(workspaceId);
          if (!companyRepo) {
            companyRepo = new CompanyRepository(db, workspaceId);
            companyRepoByWs.set(workspaceId, companyRepo);
          }
          let index = companyIndexByWs.get(workspaceId);
          if (!index) {
            index = await loadCompanyIndex(companyRepo);
            companyIndexByWs.set(workspaceId, index);
          }
          const matchId = await matchRelatedCompany(
            name,
            companyRepo,
            index,
          ).catch(() => null);
          const relatedId = await relatedRepo.upsertAuto({
            employer_id: employerId,
            workspace_id: workspaceId,
            company_id: matchId,
            company_name: name,
            normalized_company_name: normalizeCompanyName(name),
            source: 'auto',
            reason: rc.reason,
            reason_summary: rc.reason_summary ?? null,
          });
          await relatedRepo.insertEvidence({
            related_company_id: relatedId,
            email_id: emailId,
            reason: rc.reason,
            reason_summary: rc.reason_summary ?? null,
            keywords: rc.keywords ?? [],
            confidence: rc.confidence,
          });
          affectedRelatedCompanyIds.add(relatedId);
          evidenceCount++;
        }
      }
    }
    result.related_companies_evidence_inserted = evidenceCount;

    return result;
  });

  // Aggregates must run after the write txn commits (many round-trips that
  // need not hold ingest locks). Mart refresh is owned by emailProcess once
  // per invoke so soft-stop slices do not REFRESH CONCURRENTLY every batch.
  const relatedRepoPost = new EmployerRelatedCompanyRepository(deps.db);
  for (const id of affectedRelatedCompanyIds) {
    await relatedRepoPost.refreshAggregates(id);
  }

  return result;
}
