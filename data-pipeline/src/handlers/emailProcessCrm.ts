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
import type { LlmExtraction, LlmRelatedCompany } from '../mboxParser';
import { mergePeopleWithCandidates, type Candidate } from '../mboxParser';

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
    const employerValues = uniqueNew.map((d) => {
      const curated = domainName.get(d);
      const first = (d.split('.')[0] || d).toLowerCase();
      const name = curated ?? first.charAt(0).toUpperCase() + first.slice(1);
      return {
        name,
        normalized_name: normalize(name),
        industry: null as string | null,
        status: 'inbound' as const,
        curation_status: 'published' as const,
      };
    });
    const byNorm = new Map<string, (typeof employerValues)[number]>();
    for (const v of employerValues) {
      if (!byNorm.has(v.normalized_name)) byNorm.set(v.normalized_name, v);
    }
    const employerRows = await employerRepo.upsertBatch([...byNorm.values()]);
    result.employers_upserted = employerRows.length;
    const normToId = new Map(
      employerRows.map((r) => [r.normalized_name, r.id]),
    );
    for (const d of uniqueNew) {
      const curated = domainName.get(d);
      const first = (d.split('.')[0] || d).toLowerCase();
      const name = curated ?? first.charAt(0).toUpperCase() + first.slice(1);
      const id = normToId.get(normalize(name));
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

    const corrByEmail = new Map<
      string,
      {
        employer_id: string;
        email: string;
        name: string;
        title: string | null;
        phone: string | null;
        type: 'internal' | 'external';
        source: string;
      }
    >();
    for (const m of messages) {
      const people = mergePeopleWithCandidates(
        m.llm?.people ?? [],
        m.candidates,
      );
      const byEmail = new Map(
        people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]),
      );
      for (const addr of [
        m.from_address,
        ...m.to_addresses,
        ...m.cc_addresses,
      ]) {
        if (!addr || skipCrmPerson(addr, excludedDomains)) continue;
        const d = domainOf(addr);
        const employerId = domainToEmployerId.get(d);
        if (!employerId) continue;
        const key = addr.toLowerCase();
        if (corrByEmail.has(key)) continue;
        const person = byEmail.get(key);
        corrByEmail.set(key, {
          employer_id: employerId,
          email: key,
          name:
            person?.name ||
            (addr === m.from_address ? m.from_display_name : null) ||
            addr,
          title: person?.role ?? null,
          phone: person?.phone ?? null,
          type: 'external',
          source: 'mbox',
        });
      }
    }
    const correspondentRows = await correspondentRepo.upsertBatch([
      ...corrByEmail.values(),
    ]);
    result.correspondents_upserted = correspondentRows.length;
    const emailToCorrId = new Map(
      correspondentRows
        .filter((c) => c.email)
        .map((c) => [c.email!.toLowerCase(), c.id]),
    );

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

    await db.execute(sql`
      INSERT INTO employer_topics (employer_id, topic_id, source)
      SELECT DISTINCT e.employer_id, et.topic_id, 'auto'
      FROM analytics.emails e
      JOIN analytics.email_topics et ON et.email_id = e.id
      WHERE e.employer_id IS NOT NULL
        AND e.message_id IN (${sql.join(
          messages.map((m) => sql`${m.message_id}`),
          sql`, `,
        )})
      ON CONFLICT (employer_id, topic_id) DO NOTHING
    `);

    const teamAssignments: Array<{ employer_id: string; user_id: string }> = [];
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
      for (const employer_id of employerIds) {
        for (const user_id of userIds) {
          teamAssignments.push({ employer_id, user_id });
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
