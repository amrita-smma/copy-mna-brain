import {
  AiWorkforceQueueRepository,
  isTerminalWorkforceStatus,
  type CompanyRepository,
  type Correspondent,
  type DbClient,
  type Employer,
  type EmployerDomainRepository,
  type EmployerRepository,
  type CorrespondentRepository,
  type Tables,
} from '@/lib/repositories';
import {
  CRM_COMPANY_CONTACTS_AGENT_NAME,
  MAX_COMPANY_CONTACTS,
  domainFromWebsite,
  partnershipRoleRank,
} from '@/lib/agents/crm_contact/constants';
import {
  buildCompanyContactsPrompt,
  buildCompanyContactsTitle,
} from '@/lib/agents/crm_contact/companyContactsPrompt';
import { companyDisplayName } from '@/lib/companyDisplay';
import type { ImportContactRow } from '@/lib/crm/contactImport';
import { enqueueAgentRun } from '@/lib/workforce';
import { runWithWorkforceWorkspaceId } from '@/lib/workspace';
import { normalizeEmployerName, type CRMService } from './crmService';
import {
  toContactEnrichmentRun,
  type ContactEnrichmentRun,
} from './crmContactEnrichmentService';
import { publishLiveEvent } from '@/lib/server/liveEvents';
import { LIVE_TOPICS } from '@/lib/live/topics';

/** The CRM employer a company resolves to, and how. */
export interface CompanyCrmEmployer {
  id: string;
  name: string;
  /** `stored` = `companies.crm_employer_id`; otherwise matched but not yet linked. */
  matchedBy: 'stored' | 'domain' | 'name';
}

/** What the company dialog's Contact Details card renders. */
export interface CompanyContactsState {
  /** `null` until the company is matched to, or filed into, the CRM. */
  employer: CompanyCrmEmployer | null;
  /** The employer's CRM contacts, best partnership contact first, capped. */
  contacts: Correspondent[];
  /** Every contact the CRM holds for the employer (in this workspace). */
  totalContacts: number;
  /** The latest discovery run, or `null` if contacts were never searched for. */
  run: ContactEnrichmentRun | null;
}

/**
 * Most companies one bulk discovery call will queue — each is an agent run,
 * so a backfill goes a table page at a time.
 */
export const MAX_BULK_CONTACT_DISCOVERY = 10;

/** What {@link CompanyContactDiscoveryService.discoverMany} did with each id. */
export interface BulkContactDiscoveryResult {
  queued: string[];
  /** A run was already in flight. */
  alreadyQueued: string[];
  /** `onlyMissing` and the company already has contacts or a finished search. */
  skipped: string[];
}

export class CompanyNotFoundError extends Error {
  constructor(companyId: string) {
    super(`Company ${companyId} not found in this workspace`);
    this.name = 'CompanyNotFoundError';
  }
}

type Company = Tables<'companies'>;

/**
 * A company's partnership contacts, kept in the CRM.
 *
 * A pipeline company and a CRM employer are the same thing when they share a
 * website domain (`employer_domains`, which the mailbox ingest fills) or a
 * normalized name. This service resolves that match, and on the first save
 * makes it durable — `companies.crm_employer_id`, creating the employer if
 * the CRM has never seen the company. The people @crm_contact finds then go
 * in as ordinary correspondents beside whoever the ingest or a colleague
 * already filed there, and the card shows all of them.
 *
 * Imports the agent's import-free `constants` / `companyContactsPrompt`
 * modules only, never its `index`, so LangChain stays out of
 * `createContainer`.
 */
export class CompanyContactDiscoveryService {
  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly employerRepo: EmployerRepository,
    private readonly employerDomainRepo: EmployerDomainRepository,
    private readonly correspondentRepo: CorrespondentRepository,
    private readonly crmService: CRMService,
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /**
   * The company's CRM employer, its contacts ranked by partnership role
   * (top `limit`), and the latest discovery run. Read-only: a domain or name
   * match is reported, not persisted.
   */
  async getState(
    companyId: string,
    limit: number = MAX_COMPANY_CONTACTS,
  ): Promise<CompanyContactsState> {
    const company = await this.companyRepo.findByIdOrNull(companyId);
    if (!company) throw new CompanyNotFoundError(companyId);

    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const [resolved, row] = await Promise.all([
      this.resolveEmployer(company),
      queueRepo.findLatestByCompanyId(CRM_COMPANY_CONTACTS_AGENT_NAME, companyId),
    ]);
    const all = resolved
      ? await this.correspondentRepo.findByEmployerId(resolved.employer.id, this.workspaceId)
      : [];

    return {
      employer: resolved
        ? { id: resolved.employer.id, name: resolved.employer.name, matchedBy: resolved.matchedBy }
        : null,
      contacts: rankForPartnership(all).slice(0, limit),
      totalContacts: all.length,
      run: row ? toContactEnrichmentRun(row) : null,
    };
  }

  /**
   * Batched {@link getState} for a table of companies: every company's CRM
   * employer, its ranked contacts (top `limit`) and latest run, in a fixed
   * handful of queries whatever the number of companies. Ids that are not in
   * this workspace are absent from the result. Read-only, like `getState`.
   */
  async getStates(
    companyIds: string[],
    limit: number = MAX_COMPANY_CONTACTS,
  ): Promise<Record<string, CompanyContactsState>> {
    return (await this.loadStates(companyIds, limit)).states;
  }

  private async loadStates(
    companyIds: string[],
    limit: number,
  ): Promise<{ companies: Company[]; states: Record<string, CompanyContactsState> }> {
    const ids = [...new Set(companyIds)];
    if (ids.length === 0) return { companies: [], states: {} };

    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const [companies, runs] = await Promise.all([
      this.companyRepo.findByIds(ids),
      queueRepo.findLatestByCompanyIds(CRM_COMPANY_CONTACTS_AGENT_NAME, ids),
    ]);
    const resolved = await this.resolveEmployers(companies);

    const employerIds = [...new Set([...resolved.values()].map((r) => r.employer.id))];
    const contactsByEmployer = new Map<string, Correspondent[]>();
    for (const c of await this.correspondentRepo.findByEmployerIds(employerIds, this.workspaceId)) {
      const list = contactsByEmployer.get(c.employer_id);
      if (list) list.push(c);
      else contactsByEmployer.set(c.employer_id, [c]);
    }
    const runByCompany = new Map(
      runs.map((r) => [(r.trigger_meta as { company_id?: string } | null)?.company_id, r]),
    );

    const out: Record<string, CompanyContactsState> = {};
    for (const company of companies) {
      const match = resolved.get(company.id);
      const all = match ? (contactsByEmployer.get(match.employer.id) ?? []) : [];
      const run = runByCompany.get(company.id);
      out[company.id] = {
        employer: match
          ? { id: match.employer.id, name: match.employer.name, matchedBy: match.matchedBy }
          : null,
        contacts: rankForPartnership(all).slice(0, limit),
        totalContacts: all.length,
        run: run ? toContactEnrichmentRun(run) : null,
      };
    }
    return { companies, states: out };
  }

  /**
   * Queue a contact search for each of `companyIds` (at most
   * {@link MAX_BULK_CONTACT_DISCOVERY}), skipping any with a run in flight.
   * With `onlyMissing`, also skip companies that already have CRM contacts or
   * whose last search succeeded — a backfill that never pays twice for a
   * company. One company failing to queue does not stop the rest.
   */
  async discoverMany(
    companyIds: string[],
    opts: { triggeredByUserId?: string | null; onlyMissing?: boolean } = {},
  ): Promise<BulkContactDiscoveryResult> {
    const ids = [...new Set(companyIds)].slice(0, MAX_BULK_CONTACT_DISCOVERY);
    const result: BulkContactDiscoveryResult = { queued: [], alreadyQueued: [], skipped: [] };
    if (ids.length === 0) return result;

    const { companies, states } = await this.loadStates(ids, 0);
    for (const company of companies) {
      const id = company.id;
      const state = states[id];
      if (state.run?.active) {
        result.alreadyQueued.push(id);
        continue;
      }
      if (
        opts.onlyMissing &&
        (state.totalContacts > 0 || state.run?.status === 'succeeded')
      ) {
        result.skipped.push(id);
        continue;
      }
      try {
        const { created } = await this.enqueueDiscovery(company, opts.triggeredByUserId ?? null);
        (created ? result.queued : result.alreadyQueued).push(id);
      } catch (err) {
        console.error(`[companyContacts] failed to queue a contact search for ${id}:`, err);
      }
    }
    return result;
  }

  /**
   * File people found for the company into the CRM, under its employer —
   * linking (or creating) that employer first. Merges into existing contacts
   * by email or name; see {@link CRMService.addContactsToEmployer}.
   */
  async saveContacts(
    companyId: string,
    rows: Omit<ImportContactRow, 'firm'>[],
    opts: { editedBy?: string | null } = {},
  ): Promise<{
    employer: Employer;
    createdIds: string[];
    mergedIds: string[];
    /** Merged people whose CRM record (matched by email) is under a different firm. */
    mergedElsewhere: Array<{ id: string; name: string; employerId: string }>;
  }> {
    const company = await this.companyRepo.findByIdOrNull(companyId);
    if (!company) throw new CompanyNotFoundError(companyId);

    const employer = await this.linkEmployer(company);
    const result = await this.crmService.addContactsToEmployer(employer.id, rows, {
      source: 'crm_contact',
      editedBy: opts.editedBy ?? null,
    });
    await publishLiveEvent(this.workspaceId, LIVE_TOPICS.contacts, [companyId]);
    return {
      employer,
      createdIds: result.createdIds,
      mergedIds: result.merged.map((c) => c.id),
      mergedElsewhere: result.merged
        .filter((c) => c.employer_id !== employer.id)
        .map((c) => ({ id: c.id, name: c.name, employerId: c.employer_id })),
    };
  }

  /**
   * Queue a run that finds this company's partnership contacts.
   *
   * Joins an in-flight run rather than stacking a second one; a per-minute
   * idempotency key collapses truly concurrent clicks at the unique index,
   * as in `CrmContactEnrichmentService`.
   */
  async discover(
    companyId: string,
    opts: { triggeredByUserId?: string | null } = {},
  ): Promise<{ run: ContactEnrichmentRun; created: boolean }> {
    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const existing = await queueRepo.findLatestByCompanyId(
      CRM_COMPANY_CONTACTS_AGENT_NAME,
      companyId,
    );
    if (existing && !isTerminalWorkforceStatus(existing.status)) {
      return { run: toContactEnrichmentRun(existing), created: false };
    }

    const company = await this.companyRepo.findByIdOrNull(companyId);
    if (!company) throw new CompanyNotFoundError(companyId);
    return this.enqueueDiscovery(company, opts.triggeredByUserId ?? null);
  }

  /**
   * Put a discovery run for `company` on the AI Workforce queue. The caller
   * has already checked that no run is in flight.
   */
  private async enqueueDiscovery(
    company: Company,
    triggeredByUserId: string | null,
  ): Promise<{ run: ContactEnrichmentRun; created: boolean }> {
    const queueRepo = new AiWorkforceQueueRepository(this.db, this.workspaceId);
    const companyId = company.id;
    const companyName = companyDisplayName(company, 'Unnamed company');
    const prompt = buildCompanyContactsPrompt({
      companyId,
      companyName,
      website: company.website,
    });

    // Pin the queue row to this service's workspace: a job handler (the
    // market scan's auto-enrichment) has no session for enqueue to read.
    const enqueue = (idempotencyKey: string | null) =>
      runWithWorkforceWorkspaceId(this.workspaceId, () =>
        enqueueAgentRun(this.db, {
          agentName: CRM_COMPANY_CONTACTS_AGENT_NAME,
          triggerSource: 'api',
          // findLatestByCompanyId matches on trigger_meta.company_id.
          triggerMeta: { company_id: companyId },
          input: {
            title: buildCompanyContactsTitle(companyName),
            prompt,
            instruction: prompt,
            company_id: companyId,
          },
          triggeredByUserId,
          idempotencyKey,
        }),
      );

    let { runId, created } = await enqueue(
      CompanyContactDiscoveryService.idempotencyKey(companyId),
    );
    let row = await queueRepo.findById(runId);

    // The key collapsed onto a run that already finished (a re-run within the
    // same minute) — nothing is in flight, so honour the request keyless.
    if (!created && row && isTerminalWorkforceStatus(row.status)) {
      ({ runId, created } = await enqueue(null));
      row = await queueRepo.findById(runId);
    }

    if (!row) throw new Error(`discover: queue row ${runId} is not readable`);
    return { run: toContactEnrichmentRun(row), created };
  }

  /**
   * Which CRM employer is this company? The stored link wins; otherwise the
   * website domain (the ingest's own identity key), then the normalized name.
   * A stored link whose employer was deleted falls through to matching.
   */
  private async resolveEmployer(
    company: Company,
  ): Promise<{ employer: Employer; matchedBy: CompanyCrmEmployer['matchedBy'] } | null> {
    if (company.crm_employer_id) {
      const employer = await this.employerRepo.findById(company.crm_employer_id, this.workspaceId);
      if (employer) return { employer, matchedBy: 'stored' };
    }
    const domain = domainFromWebsite(company.website);
    if (domain) {
      const mapping = await this.employerDomainRepo.findByDomain(domain);
      const employer = mapping
        ? await this.employerRepo.findById(mapping.employer_id, this.workspaceId)
        : undefined;
      if (employer) return { employer, matchedBy: 'domain' };
    }
    const name = companyDisplayName(company, '');
    if (name) {
      const employer = await this.employerRepo.findByNormalizedName(normalizeEmployerName(name));
      if (employer && (await this.nameMatchAgreesOnDomain(employer.id, domain))) {
        return { employer, matchedBy: 'name' };
      }
    }
    return null;
  }

  /**
   * Batched {@link resolveEmployer}, same precedence (stored link, then
   * domain, then a name match that agrees on domain), in at most five
   * queries. Keep the two in step.
   */
  private async resolveEmployers(
    companies: Company[],
  ): Promise<Map<string, { employer: Employer; matchedBy: CompanyCrmEmployer['matchedBy'] }>> {
    const out = new Map<string, { employer: Employer; matchedBy: CompanyCrmEmployer['matchedBy'] }>();
    if (companies.length === 0) return out;

    const domainOf = new Map(companies.map((c) => [c.id, domainFromWebsite(c.website)]));
    const nameOf = new Map(
      companies.map((c) => [c.id, normalizeEmployerName(companyDisplayName(c, ''))]),
    );
    const domains = [...new Set([...domainOf.values()].filter((d): d is string => !!d))];
    const names = [...new Set([...nameOf.values()].filter(Boolean))];

    const [domainRows, nameMatches] = await Promise.all([
      this.employerDomainRepo.findManyByDomains(domains),
      this.employerRepo.findByNormalizedNames(names),
    ]);
    const employerByDomain = new Map(domainRows.map((r) => [r.domain, r.employer_id]));
    const storedIds = companies.map((c) => c.crm_employer_id).filter((id): id is string => !!id);
    const byId = new Map(
      (await this.employerRepo.findByIds(
        [...new Set([...storedIds, ...employerByDomain.values()])],
        this.workspaceId,
      ))
        .map((e) => [e.id, e]),
    );
    const byName = new Map<string, Employer>();
    for (const e of nameMatches) if (!byName.has(e.normalized_name)) byName.set(e.normalized_name, e);
    const employersWithDomains = new Set(
      (await this.employerDomainRepo.findByEmployerIds([...new Set(nameMatches.map((e) => e.id))]))
        .map((d) => d.employer_id),
    );

    for (const company of companies) {
      const stored = company.crm_employer_id ? byId.get(company.crm_employer_id) : undefined;
      if (stored) {
        out.set(company.id, { employer: stored, matchedBy: 'stored' });
        continue;
      }
      const domain = domainOf.get(company.id);
      const domainEmployerId = domain ? employerByDomain.get(domain.toLowerCase()) : undefined;
      const byDomain = domainEmployerId ? byId.get(domainEmployerId) : undefined;
      if (byDomain) {
        out.set(company.id, { employer: byDomain, matchedBy: 'domain' });
        continue;
      }
      const name = nameOf.get(company.id);
      const named = name ? byName.get(name) : undefined;
      // A same-name employer with domains of its own is a different firm
      // when the company has a domain (see nameMatchAgreesOnDomain).
      if (named && (!domain || !employersWithDomains.has(named.id))) {
        out.set(company.id, { employer: named, matchedBy: 'name' });
      }
    }
    return out;
  }

  /**
   * A same-name employer is a different firm when both sides have a domain
   * and they disagree — "Acme" the target and "Acme" the bank. The domain
   * lookup above already failed, so any domain the employer has is not ours.
   */
  private async nameMatchAgreesOnDomain(
    employerId: string,
    companyDomain: string | undefined,
  ): Promise<boolean> {
    if (!companyDomain) return true;
    const domains = await this.employerDomainRepo.findByEmployerId(employerId);
    return domains.length === 0;
  }

  /**
   * Make the company ↔ employer link durable, creating the employer when the
   * CRM has never seen this company. Only a NEW employer claims the website
   * domain (so the mailbox ingest files the company's emails under it): a
   * name-matched one is not proven to be this company's firm, and claiming
   * for it would misfile every future email from that domain. The claim
   * never re-points a domain another employer already owns.
   */
  private async linkEmployer(company: Company): Promise<Employer> {
    const resolved = await this.resolveEmployer(company);
    if (resolved?.matchedBy === 'stored') return resolved.employer;

    const employer =
      resolved?.employer ??
      (await this.crmService.findOrCreateEmployer(companyDisplayName(company, 'Unnamed company')));
    const domain = domainFromWebsite(company.website);
    if (domain && !resolved) {
      await this.employerDomainRepo.persistMany([
        { employer_id: employer.id, domain, source: 'manual' },
      ]);
    }
    await this.companyRepo.update(company.id, { crm_employer_id: employer.id });
    return employer;
  }

  private static idempotencyKey(companyId: string): string {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    return `${CRM_COMPANY_CONTACTS_AGENT_NAME}:${companyId}:${minuteBucket}`;
  }
}

/** Best partnership contact first; ties keep the CRM's own (oldest-first) order. */
export function rankForPartnership(contacts: Correspondent[]): Correspondent[] {
  return contacts
    .map((c, i) => ({ c, i, rank: partnershipRoleRank(c.title) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ c }) => c);
}
