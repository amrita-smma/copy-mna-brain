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
import { normalizeEmployerName, type CRMService } from './crmService';
import {
  toContactEnrichmentRun,
  type ContactEnrichmentRun,
} from './crmContactEnrichmentService';

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

    const companyName = companyDisplayName(company, 'Unnamed company');
    const prompt = buildCompanyContactsPrompt({
      companyId,
      companyName,
      website: company.website,
    });

    const enqueue = (idempotencyKey: string | null) =>
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
        triggeredByUserId: opts.triggeredByUserId ?? null,
        idempotencyKey,
      });

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
      const employer = await this.employerRepo.findById(company.crm_employer_id);
      if (employer) return { employer, matchedBy: 'stored' };
    }
    const domain = domainFromWebsite(company.website);
    if (domain) {
      const mapping = await this.employerDomainRepo.findByDomain(domain);
      const employer = mapping ? await this.employerRepo.findById(mapping.employer_id) : undefined;
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
