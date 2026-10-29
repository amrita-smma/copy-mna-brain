import type {
  CompanyRepository,
  ContactConversationRepository,
  UserWorkspaceRepository,
  VaultExportRepository,
  Correspondent,
  CorrespondentCurationEdit,
  CorrespondentInsert,
  CorrespondentCurationRepository,
  CorrespondentRepository,
  EmailRepository,
  Employer,
  EmployerCurationRepository,
  EmployerListFilters,
  EmployerNote,
  EmployerNoteListItem,
  EmployerNoteRepository,
  EmployerNoteRevisionItem,
  EmployerRelatedCompanyRanking,
  EmployerRelatedCompanyRepository,
  EmployerRepository,
  EmployerSummary,
  EmployerTeamRepository,
  EmployerTopicAssignment,
  EmployerUpdate,
  MatchedContact,
  RelatedCompanyWithEvidence,
  TeamMember,
  Topic,
  TopicRepository,
  WorkspaceCorrespondentRepository,
} from "@/lib/repositories";
import { normalizeCompanyName } from "@/lib/crm/normalizeCompanyName";
import type { CrmContactEnrichmentService } from "./crmContactEnrichmentService";
import {
  collapseByEmail,
  normalizeEmail,
  type ImportContactRow,
} from "@/lib/crm/contactImport";

export class DuplicateEmployerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateEmployerError";
  }
}

/** A team assignment named someone who is not a member of this workspace. */
export class InvalidTeamMemberError extends Error {
  constructor(userIds: string[]) {
    super(`Not members of this workspace: ${userIds.join(", ")}`);
    this.name = "InvalidTeamMemberError";
  }
}

/** The contact does not exist, or is not visible in this workspace. */
export class CorrespondentNotFoundError extends Error {
  constructor(id: string) {
    super(`Contact ${id} not found`);
    this.name = "CorrespondentNotFoundError";
  }
}

export class EmployerNoteNotFoundError extends Error {
  constructor(id: string) {
    super(`Note ${id} not found`);
    this.name = "EmployerNoteNotFoundError";
  }
}

export class EmployerNotFoundError extends Error {
  constructor(id: string) {
    super(`Employer ${id} not found`);
    this.name = "EmployerNotFoundError";
  }
}

/**
 * Collapse auto + manual rows that point at the same company into one display
 * row. The `source` column is part of the UNIQUE key, so the same company can
 * legitimately exist as both an auto suggestion and a manual link; we show it
 * once. Keyed on `company_id` (the reliable "same company" signal — auto and
 * manual normalize different source strings), falling back to the normalized
 * name for unmatched auto rows. The manual row wins, but absorbs the auto row's
 * evidence so the "why was this detected" trail isn't lost.
 */
function dedupeRelatedCompanies(
  rows: RelatedCompanyWithEvidence[],
): RelatedCompanyWithEvidence[] {
  const groups = new Map<string, RelatedCompanyWithEvidence[]>();
  for (const r of rows) {
    const key = r.company_id ?? `name:${r.normalized_company_name}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const out: RelatedCompanyWithEvidence[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const primary =
      group.find((r) => r.source === "manual") ?? group[0];
    const mergedEvidence = group.flatMap((r) => r.evidence);
    out.push({
      ...primary,
      evidence: mergedEvidence,
      evidence_count: mergedEvidence.length,
    });
  }
  return out;
}

/** A banker (employer) ranked by the number of related companies attached to
 * it — the DTO returned to the dashboard "Banker related companies" card.
 * Re-exported from the repository ranking shape. */
export type BankerRelatedCompaniesRow = EmployerRelatedCompanyRanking;

export interface EmployerDetail {
  employer: Employer;
  primary_pic: Correspondent | null;
  /** Contacts this workspace sees at the firm. The rows themselves are paged
   * and searched through listContactsPage — a large firm has thousands. */
  contact_count: number;
  notes: EmployerNoteListItem[];
  topics: EmployerTopicAssignment[];
  team: TeamMember[];
  email_count: number;
  last_contact_at: string | null;
  related_companies: RelatedCompanyWithEvidence[];
}

/**
 * Industry / Area Focus the relationship overview inferred from each contact's
 * emails, by contact id. A fallback the contacts table shows, badged, only
 * where the contact's own `specialization` / `coverage_region` is empty.
 * Contacts with no inference are absent.
 */
export type InferredFocusByContact = Record<
  string,
  { industry_focus: string | null; area_focus: string | null }
>;

export interface ContactsPage {
  data: Correspondent[];
  /** Contacts matching the search (all of the firm's when there is none). */
  total: number;
  inferred_focus: InferredFocusByContact;
}

export interface CRMInsights {
  stale_employers: number;
  flagged_records: number;
  emails_today: number;
  /** Number of mailboxes the Vault sync is configured against. */
  email_accounts: number | null;
  /** ISO timestamp of the most recent successful Vault sync, if any. */
  last_synced_at: string | null;
  /** ISO timestamp of the next expected Vault sync (last + cadence). */
  next_sync_at: string | null;
}

export interface InsightsContext {
  /** Client's today timestamp in ISO format for time-relative insights. */
  clientTodayIso?: string;
}

/** Outcome of `CRMService.importContacts`. */
export interface ImportContactsResult {
  /** New contacts inserted. */
  created: number;
  /** Rows whose email matched an existing contact (manual or ingested). */
  merged: number;
  /** Rows dropped — a repeated email in the same file, or no firm to file under. */
  skipped: number;
  errors: string[];
}

export interface CreateContactInput {
  employerId?: string;
  /**
   * Free-text firm name. If `employerId` is omitted, the service will
   * find-or-create an employer with this name (using `normalize_name` for
   * fuzzy dedupe).
   */
  firmName?: string;
  name: string;
  email?: string;
  phone?: string;
  title?: string;
  type?: string;
  department?: string;
  specialization?: string;
  seniority?: string;
  coverageRegion?: string;
  linkedinUrl?: string;
  bio?: string;
  isPrimary?: boolean;
}

/**
 * Correspondent fields a human edit routes to the `correspondent_curation`
 * overlay rather than the machine-owned `correspondents` base row (RFC §3.4),
 * so a later ETL re-ingest can never clobber the edit.
 */
const OVERLAY_CONTACT_FIELDS = [
  "name",
  "title",
  "phone",
  "type",
  "department",
  "specialization",
  "seniority",
  "coverage_region",
  "linkedin_url",
  "bio",
] as const satisfies ReadonlyArray<keyof CorrespondentCurationEdit>;

/**
 * Every field the CRM contact editor may write, named exactly as it arrives in
 * the request body. Enumerated so a route can whitelist an untrusted body
 * (`pickEditableContactFields`) instead of forwarding arbitrary column names.
 */
export const EDITABLE_CONTACT_FIELDS = [
  ...OVERLAY_CONTACT_FIELDS,
  // The only editable field that is NOT an overlay column: `email` is the
  // natural key behind the `(employer_id, email)` ingest upsert, so it has to
  // stay on the base table where that unique index lives.
  "email",
] as const;

export type EditableContactField = (typeof EDITABLE_CONTACT_FIELDS)[number];

/**
 * Fields the contact editor cannot set. The bio is the AI-generated profile:
 * only Get Full Profile / Refresh (@crm_contact) write it, through
 * `updateContact` directly, so a hand edit can never pass for AI research.
 */
const AI_ONLY_CONTACT_FIELDS: ReadonlySet<EditableContactField> = new Set(["bio"]);

/**
 * What `CRMService.updateContact` accepts. Deliberately narrower than
 * `Partial<CorrespondentInsert>`: only human-editable fields, plus the
 * editor stamp. `null` clears a field — for an overlay column that means the
 * machine value on `correspondents` shows through again.
 */
export type UpdateContactInput = Partial<
  Record<EditableContactField, string | null>
> & {
  last_edited_by_user_id?: string | null;
};

/**
 * Narrows an untrusted request body to the editable contact fields, so a route
 * can never forward `origin`, `employer_id`, `source` or any other
 * machine-owned column into `CRMService.updateContact`. Values are trimmed;
 * an empty string clears the field (`null`) rather than storing `""`.
 */
export function pickEditableContactFields(
  body: Record<string, unknown>,
): Partial<Record<EditableContactField, string | null>> {
  const out: Partial<Record<EditableContactField, string | null>> = {};
  for (const field of EDITABLE_CONTACT_FIELDS) {
    if (AI_ONLY_CONTACT_FIELDS.has(field)) continue;
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    out[field] = trimmed === "" ? null : trimmed;
  }
  return out;
}

/** How `employers.normalized_name` is derived — the employer match key. */
export function normalizeEmployerName(s: string): string {
  return normalizeName(s);
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Vault exports run daily; the insights bar shows the next expected sync. */
const VAULT_SYNC_CADENCE_MS = DAY_MS;

/** Where the insights bar's mailbox-sync status comes from. */
export interface VaultSyncSources {
  vaultExportRepo: Pick<VaultExportRepository, "findLastArchivedAt">;
  userWorkspaceRepo: Pick<UserWorkspaceRepository, "countSyncedCustodians">;
}

export class CRMService {
  constructor(
    private employerRepo: EmployerRepository,
    private correspondentRepo: CorrespondentRepository,
    private noteRepo: EmployerNoteRepository,
    private topicRepo: TopicRepository,
    private emailRepo: EmailRepository,
    private teamRepo: EmployerTeamRepository,
    // RFC §3: human field edits land in the overlay tables, never on the
    // machine base columns the ETL owns.
    private employerCurationRepo: EmployerCurationRepository,
    private correspondentCurationRepo: CorrespondentCurationRepository,
    private relatedCompanyRepo: EmployerRelatedCompanyRepository,
    private companyRepo: CompanyRepository,
    private workspaceCorrespondentRepo: WorkspaceCorrespondentRepository,
    private workspaceId: string,
    // Fills a new primary contact's profile; absent where the caller never
    // changes the primary (and in tests that don't exercise it).
    private contactEnrichment?: Pick<CrmContactEnrichmentService, "enrichNewPrimary">,
    // Reads the AI-inferred focus fallbacks; absent in tests that don't need them.
    private contactConversationRepo?: Pick<ContactConversationRepository, "findInferredFocus">,
    // Mailbox-sync status for the insights bar; absent in tests that don't
    // need it, in which case the bar reports no sync state.
    private vaultSync?: VaultSyncSources,
  ) {}

  // ─── Employers ───────────────────────────────────────────────────────────

  async listEmployers(
    filters: EmployerListFilters = {},
  ): Promise<{ data: EmployerSummary[]; total: number }> {
    const [data, total] = await Promise.all([
      this.employerRepo.list(filters, this.workspaceId),
      this.employerRepo.count(filters, this.workspaceId),
    ]);
    const search = filters.search?.trim();
    if (!search || data.length === 0) return { data, total };

    // Person search: one batched query for the page's firms tells the UI which
    // contacts matched, so it can open those firms and show only those people
    // without loading every contact client-side.
    const matches = await this.correspondentRepo.searchInEmployers(
      data.map((e) => e.id),
      search,
      this.workspaceId,
    );
    const byEmployer = new Map<string, MatchedContact[]>();
    for (const m of matches) {
      const list = byEmployer.get(m.employer_id);
      if (list) list.push(m);
      else byEmployer.set(m.employer_id, [m]);
    }
    return {
      data: data.map((e) => ({
        ...e,
        matched_contacts: byEmployer.get(e.id) ?? [],
      })),
      total,
    };
  }

  async getEmployerDetail(id: string): Promise<EmployerDetail> {
    const employer = await this.employerRepo.findById(id, this.workspaceId);
    if (!employer) throw new EmployerNotFoundError(id);

    const [primary_pic, contactCount, notes, topics, team, emailCount, emails, relatedCompanies] =
      await Promise.all([
        this.correspondentRepo.findPrimaryByEmployerId(id, this.workspaceId),
        this.correspondentRepo.countByEmployerId(id, this.workspaceId),
        this.noteRepo.findByEmployerId(id, this.workspaceId),
        this.topicRepo.listForEmployer(id, this.workspaceId),
        this.teamRepo.listForEmployer(this.workspaceId, id),
        this.emailRepo.countByEmployer(id),
        this.emailRepo.findByEmployerId(id, { limit: 1 }),
        this.relatedCompanyRepo.listForEmployer(id, this.workspaceId),
      ]);

    return {
      employer,
      primary_pic,
      contact_count: contactCount,
      notes,
      topics,
      team,
      email_count: emailCount,
      last_contact_at: emails[0]?.sent_at ?? null,
      related_companies: dedupeRelatedCompanies(relatedCompanies),
    };
  }

  /**
   * Bankers (employers) in this workspace ranked by how many distinct related
   * companies are attached to each, most first. Backs the dashboard "Banker
   * related companies" card.
   */
  async getBankersByRelatedCompanyCount(): Promise<BankerRelatedCompaniesRow[]> {
    return this.relatedCompanyRepo.rankByRelatedCompanyCount(this.workspaceId);
  }

  async createEmployer(input: {
    name: string;
    industry?: string;
    status?: "inbound" | "outbound";
    curation_status?: "published" | "flagged";
  }): Promise<Employer> {
    const normalized = normalizeName(input.name);
    const existing = await this.employerRepo.findByNormalizedName(normalized);
    if (existing) {
      throw new DuplicateEmployerError(
        `An employer named "${existing.name}" already exists`,
      );
    }
    return this.employerRepo.insert({
      name: input.name,
      normalized_name: normalized,
      industry: input.industry,
      status: input.status ?? "inbound",
      curation_status: input.curation_status ?? "published",
    });
  }

  async findOrCreateEmployer(name: string): Promise<Employer> {
    const normalized = normalizeName(name);
    const existing = await this.employerRepo.findByNormalizedName(normalized);
    if (existing) return existing;
    return this.employerRepo.insert({
      name,
      normalized_name: normalized,
      status: "inbound",
      curation_status: "published",
    });
  }

  async updateEmployer(id: string, data: EmployerUpdate): Promise<Employer> {
    // Split: name/industry are machine-derived → human edits go to the overlay
    // (and normalized_name, the merge key, is deliberately NOT touched on a
    // rename — it stays on the machine value, RFC §4.2). status/curation_status
    // are purely-human workflow fields → base.
    const overlay: { name?: string | null; industry?: string | null } = {};
    if (data.name !== undefined) overlay.name = data.name;
    if (data.industry !== undefined) overlay.industry = data.industry;
    if (Object.keys(overlay).length > 0) {
      await this.employerCurationRepo.upsert(this.workspaceId, id, overlay, null);
    }

    const base: EmployerUpdate = {};
    if (data.status !== undefined) base.status = data.status;
    if (data.curation_status !== undefined) base.curation_status = data.curation_status;
    if (Object.keys(base).length > 0) {
      const updated = await this.employerRepo.update(id, base);
      if (!updated) throw new EmployerNotFoundError(id);
    }

    const effective = await this.employerRepo.findById(id, this.workspaceId);
    if (!effective) throw new EmployerNotFoundError(id);
    return effective;
  }

  async deleteEmployer(id: string): Promise<void> {
    await this.employerRepo.delete(id);
  }

  /**
   * Mark a flagged record as reviewed. Both "approve" and "skip" land here —
   * approve publishes it (optionally with corrected employer fields and a
   * primary-PIC patch), skip leaves it flagged but bumps updated_at so the
   * same record doesn't immediately resurface in the curation queue.
   */
  async curateEmployer(
    id: string,
    decision: "approve" | "skip",
    patch: EmployerUpdate & {
      primary_pic?: {
        name?: string | null;
        title?: string | null;
        email?: string | null;
        phone?: string | null;
      };
    } = {},
  ): Promise<Employer> {
    const { primary_pic: picPatch, ...employerPatch } = patch;

    // Machine-derived employer fields → overlay (no normalized_name change).
    const overlay: { name?: string | null; industry?: string | null } = {};
    if (employerPatch.name !== undefined) overlay.name = employerPatch.name;
    if (employerPatch.industry !== undefined) overlay.industry = employerPatch.industry;
    if (Object.keys(overlay).length > 0) {
      await this.employerCurationRepo.upsert(this.workspaceId, id, overlay, null);
    }

    // Workflow fields → base. Always call update so "skip" bumps updated_at and
    // the record falls to the back of the curation queue.
    const base: EmployerUpdate = {};
    if (employerPatch.status !== undefined) base.status = employerPatch.status;
    if (decision === "approve") base.curation_status = "published";
    else if (employerPatch.curation_status !== undefined) {
      base.curation_status = employerPatch.curation_status;
    }
    const updated = await this.employerRepo.update(id, base);
    if (!updated) throw new EmployerNotFoundError(id);

    if (decision === "approve" && picPatch) {
      const correspondents = await this.correspondentRepo.findByEmployerId(
        id,
        this.workspaceId,
      );
      const primary =
        correspondents.find((c) => c.is_primary) ?? correspondents[0] ?? null;

      const pic: Partial<CorrespondentInsert> = {};
      if (picPatch.name !== undefined && picPatch.name !== null && picPatch.name.trim()) {
        pic.name = picPatch.name.trim();
      }
      if (picPatch.title !== undefined) pic.title = picPatch.title ?? null;
      if (picPatch.email !== undefined) pic.email = picPatch.email ?? null;
      if (picPatch.phone !== undefined) pic.phone = picPatch.phone ?? null;

      if (primary) {
        // Routes name/title/phone → overlay, email → base (see updateContact).
        if (Object.keys(pic).length > 0) {
          await this.updateContact(primary.id, pic);
        }
      } else if (pic.name) {
        // Brand-new human-authored contact: base row, origin='manual'.
        const created = await this.correspondentRepo.insert(
          {
            employer_id: id,
            name: pic.name,
            title: pic.title ?? null,
            email: pic.email ?? null,
            phone: pic.phone ?? null,
            source: "manual",
            origin: "manual",
          },
          this.workspaceId,
        );
        await this.workspaceCorrespondentRepo.addMembership(
          this.workspaceId,
          created.id,
          "manual",
        );
      }
    }

    return this.employerRepo.findById(id, this.workspaceId) as Promise<Employer>;
  }

  // ─── Correspondents ──────────────────────────────────────────────────────

  async createContact(input: CreateContactInput): Promise<Correspondent> {
    if (!input.employerId && !input.firmName) {
      throw new Error("employerId or firmName is required");
    }

    const employer = input.employerId
      ? await this.employerRepo.findById(input.employerId, this.workspaceId)
      : await this.findOrCreateEmployer(input.firmName!);

    if (!employer) {
      throw new EmployerNotFoundError(input.employerId ?? "(unknown)");
    }

    const email = normalizeEmail(input.email);
    if (email) {
      const dupe = pickCanonicalByEmail(
        await this.correspondentRepo.findByEmails([email]),
        employer.id,
      ).get(email);
      if (dupe) {
        // Email is the join key between manual and email-ingested contacts —
        // across employers, since a human-picked firm and the ingest's
        // domain-derived employer can differ. Adding a contact that already
        // exists = a human edit of that row → overlay via updateContact. Also
        // ensures this workspace gets a membership row, so re-adding a contact
        // that was only visible to another workspace makes it visible here too.
        await this.workspaceCorrespondentRepo.addMembership(
          this.workspaceId,
          dupe.id,
          "manual",
        );
        return this.updateContact(dupe.id, {
          name: input.name,
          title: input.title,
          phone: input.phone,
          type: input.type,
          department: input.department,
          specialization: input.specialization,
          seniority: input.seniority,
          coverage_region: input.coverageRegion,
          linkedin_url: input.linkedinUrl,
          bio: input.bio,
        });
      }
    }

    const created = await this.correspondentRepo.insert(
      {
        employer_id: employer.id,
        name: input.name,
        email,
        phone: input.phone,
        title: input.title,
        type: input.type,
        department: input.department,
        specialization: input.specialization,
        seniority: input.seniority,
        coverage_region: input.coverageRegion,
        linkedin_url: input.linkedinUrl,
        bio: input.bio,
        source: "manual",
        // Human-added: the ETL must never touch this row (RFC §3.4).
        origin: "manual",
      },
      this.workspaceId,
    );
    await this.workspaceCorrespondentRepo.addMembership(
      this.workspaceId,
      created.id,
      "manual",
    );
    return created;
  }

  /**
   * Bulk-adds contacts from a CSV import, merging into existing contacts by
   * email (case-insensitive, across employers) so manually-imported and
   * email-ingested people collapse into one record:
   *
   * - email matches an existing contact → its non-blank fields go to the
   *   curation overlay (a human edit; blanks never clear) and the workspace
   *   gains a membership row. Its employer is left as-is.
   * - otherwise → a new `origin='manual'` contact under the row's firm (or the
   *   email's domain when no firm is given), find-or-creating the employer.
   *
   * A fixed number of batched queries regardless of row count.
   */
  async importContacts(
    rows: ImportContactRow[],
    editedBy: string | null = null,
  ): Promise<ImportContactsResult> {
    const result: ImportContactsResult = {
      created: 0,
      merged: 0,
      skipped: 0,
      errors: [],
    };

    // Collapse repeats of one email within the batch — later rows fill blanks.
    const collapsed = collapseByEmail(rows);
    result.skipped += collapsed.duplicates;
    const byEmail = new Map<string, ImportContactRow>();
    const withoutEmail: ImportContactRow[] = [];
    for (const row of collapsed.rows) {
      if (row.email) byEmail.set(row.email, row);
      else withoutEmail.push(row);
    }

    const canonical = pickCanonicalByEmail(
      await this.correspondentRepo.findByEmails([...byEmail.keys()]),
    );

    const mergeEdits: Array<{
      correspondentId: string;
      edit: CorrespondentCurationEdit;
    }> = [];
    const toCreate: ImportContactRow[] = [...withoutEmail];
    for (const [email, row] of byEmail) {
      const existing = canonical.get(email);
      if (existing) {
        mergeEdits.push({ correspondentId: existing.id, edit: overlayOf(row) });
      } else {
        toCreate.push(row);
      }
    }

    // Resolve every firm in two queries: one lookup, one insert of the misses.
    const firmOf = (row: ImportContactRow) =>
      row.firm?.trim() || (row.email ? domainOf(row.email) : null) || null;
    const firmByNorm = new Map<string, string>();
    for (const row of toCreate) {
      const firm = firmOf(row);
      if (firm && !firmByNorm.has(normalizeName(firm))) {
        firmByNorm.set(normalizeName(firm), firm);
      }
    }
    const employerIdByNorm = new Map(
      (
        await this.employerRepo.findByNormalizedNames([...firmByNorm.keys()])
      ).map((e) => [e.normalized_name, e.id]),
    );
    const missingFirms = [...firmByNorm].filter(
      ([norm]) => !employerIdByNorm.has(norm),
    );
    for (const e of await this.employerRepo.upsertBatch(
      missingFirms.map(([norm, name]) => ({
        name,
        normalized_name: norm,
        status: "inbound",
        curation_status: "published",
      })),
    )) {
      employerIdByNorm.set(e.normalized_name, e.id);
    }

    const inserts: CorrespondentInsert[] = [];
    for (const row of toCreate) {
      const firm = firmOf(row);
      const employerId = firm
        ? employerIdByNorm.get(normalizeName(firm))
        : undefined;
      if (!employerId) {
        result.skipped++;
        result.errors.push(`${row.name}: no firm or email to file it under.`);
        continue;
      }
      inserts.push({
        employer_id: employerId,
        name: row.name,
        email: normalizeEmail(row.email),
        phone: row.phone,
        title: row.title,
        type: row.type,
        department: row.department,
        specialization: row.specialization,
        seniority: row.seniority,
        coverage_region: row.coverageRegion,
        linkedin_url: row.linkedinUrl,
        bio: row.bio,
        source: "manual",
        origin: "manual",
        last_edited_by_user_id: editedBy,
      });
    }

    await this.correspondentCurationRepo.fillMany(this.workspaceId, mergeEdits, editedBy);
    const created = await this.correspondentRepo.insertMany(inserts);
    // Rows a concurrent insert beat to `(employer_id, email)` come back empty.
    result.skipped += inserts.length - created.length;
    result.created = created.length;
    result.merged = mergeEdits.length;

    await this.workspaceCorrespondentRepo.addMemberships(
      [...mergeEdits.map((m) => m.correspondentId), ...created.map((c) => c.id)].map(
        (correspondentId) => ({
          workspaceId: this.workspaceId,
          correspondentId,
          source: "manual" as const,
        }),
      ),
    );
    return result;
  }

  /**
   * File people under one known employer, merging into contacts the CRM
   * already has rather than duplicating them. Used by @crm_contact's
   * company-contacts task, which re-runs on the same company.
   *
   * A row matches an existing contact by email (case-insensitive, across
   * employers, like {@link createContact}) or, failing that, by name within
   * this employer — agent-found people often have no published email, and a
   * refresh must not file a second "Jane Doe". A match only has its EMPTY
   * fields filled: a value someone already entered, or the ingest captured,
   * outranks a web search, and the name and email are never changed. The
   * rest are inserted as `origin='manual'` so the mailbox ingest never prunes
   * them. A fixed number of batched queries regardless of row count.
   */
  async addContactsToEmployer(
    employerId: string,
    rows: Omit<ImportContactRow, "firm">[],
    opts: { source?: string; editedBy?: string | null } = {},
  ): Promise<{ createdIds: string[]; merged: Correspondent[] }> {
    const editedBy = opts.editedBy ?? null;
    const [existing, sharedByEmailRows] = await Promise.all([
      this.correspondentRepo.findByEmployerId(employerId, this.workspaceId),
      this.correspondentRepo.findByEmails(
        rows.map((r) => normalizeEmail(r.email)).filter((e): e is string => !!e),
      ),
    ]);
    // findByEmails matches across firms on the shared row, which carries no
    // workspace edits. "Fill only empty fields" must judge emptiness against
    // what THIS workspace sees, or a field a colleague curated here reads as
    // blank and gets overwritten by the discovered value.
    const byEmailRows = await this.withWorkspaceOverlay(sharedByEmailRows);
    const byEmail = pickCanonicalByEmail(byEmailRows, employerId);
    const byName = new Map<string, Correspondent>();
    for (const c of existing) {
      const key = normalizeName(c.name);
      if (!byName.has(key)) byName.set(key, c);
    }

    const fillable: Array<[keyof ImportContactRow, keyof CorrespondentCurationEdit]> = [
      ["title", "title"],
      ["phone", "phone"],
      ["type", "type"],
      ["department", "department"],
      ["specialization", "specialization"],
      ["seniority", "seniority"],
      ["coverageRegion", "coverage_region"],
      ["linkedinUrl", "linkedin_url"],
      ["bio", "bio"],
    ];

    const seen = new Set<string>();
    const merged: Correspondent[] = [];
    const mergeEdits: Array<{ correspondentId: string; edit: CorrespondentCurationEdit }> = [];
    const inserts: CorrespondentInsert[] = [];
    for (const row of rows) {
      const email = normalizeEmail(row.email);
      const nameKey = normalizeName(row.name);
      if (seen.has(nameKey) || (email && seen.has(email))) continue;
      seen.add(nameKey);
      if (email) seen.add(email);

      const match = (email ? byEmail.get(email) : undefined) ?? byName.get(nameKey);
      if (match) {
        const edit: CorrespondentCurationEdit = {};
        for (const [from, to] of fillable) {
          const value = row[from]?.trim();
          const current = match[to as keyof Correspondent];
          if (value && !(typeof current === "string" && current.trim())) edit[to] = value;
        }
        merged.push(match);
        if (Object.keys(edit).length > 0) {
          mergeEdits.push({ correspondentId: match.id, edit });
        }
        continue;
      }
      inserts.push({
        employer_id: employerId,
        name: row.name.trim(),
        email,
        phone: row.phone,
        title: row.title,
        type: row.type,
        department: row.department,
        specialization: row.specialization,
        seniority: row.seniority,
        coverage_region: row.coverageRegion,
        linkedin_url: row.linkedinUrl,
        bio: row.bio,
        source: opts.source ?? "manual",
        origin: "manual",
        last_edited_by_user_id: editedBy,
      });
    }

    await this.correspondentCurationRepo.fillMany(this.workspaceId, mergeEdits, editedBy);
    const created = await this.correspondentRepo.insertMany(inserts);
    await this.workspaceCorrespondentRepo.addMemberships(
      [...merged, ...created].map((c) => ({
        workspaceId: this.workspaceId,
        correspondentId: c.id,
        source: "manual" as const,
      })),
    );
    // `merged` rows keep their own employer: an email match can be a contact
    // filed under another firm, and the email-keyed merge leaves it there.
    return { createdIds: created.map((c) => c.id), merged };
  }

  /**
   * Lay this workspace's curation over shared correspondent rows (one batched
   * read). For code paths that match by email on the shared row but must then
   * reason about the values this workspace actually shows.
   */
  private async withWorkspaceOverlay(rows: Correspondent[]): Promise<Correspondent[]> {
    if (rows.length === 0) return rows;
    const overlays = new Map(
      (
        await this.correspondentCurationRepo.findManyByCorrespondentIds(
          this.workspaceId,
          rows.map((r) => r.id),
        )
      ).map((o) => [o.correspondent_id, o]),
    );
    return rows.map((row) => {
      const overlay = overlays.get(row.id);
      if (!overlay) return row;
      const out = { ...row };
      for (const field of OVERLAY_CONTACT_FIELDS) {
        const value = overlay[field];
        if (value !== null && value !== undefined) out[field] = value;
      }
      return out;
    });
  }

  /**
   * One page of a firm's contacts for the CRM card, searched server-side by
   * name / email (the same match the list's person search reports).
   * `is_primary` is resolved against the firm's whole list, not the page, so
   * the badge stays on the right row on any page or search. Inferred focus is
   * read for this page's contacts only.
   */
  async listContactsPage(
    employerId: string,
    opts: { search?: string; limit: number; offset: number },
  ): Promise<ContactsPage> {
    const [rows, total, primary] = await Promise.all([
      this.correspondentRepo.findPageByEmployerId(employerId, this.workspaceId, opts),
      this.correspondentRepo.countByEmployerId(employerId, this.workspaceId, opts.search),
      this.correspondentRepo.findPrimaryByEmployerId(employerId, this.workspaceId),
    ]);
    const data = rows.map((r) => ({ ...r, is_primary: r.id === primary?.id }));

    const inferred =
      this.contactConversationRepo && data.length > 0
        ? await this.contactConversationRepo.findInferredFocus(
            this.workspaceId,
            data.map((c) => c.id),
          )
        : [];
    const inferred_focus: InferredFocusByContact = {};
    for (const f of inferred) {
      inferred_focus[f.correspondentId] = {
        industry_focus: f.industryFocus,
        area_focus: f.areaFocus,
      };
    }
    return { data, total, inferred_focus };
  }

  async updateContact(
    id: string,
    data: UpdateContactInput,
  ): Promise<Correspondent> {
    // Split: every human-editable field except email goes to the overlay.
    // email (the natural key) and last_edited_* stay on the base table.
    const editedBy = data.last_edited_by_user_id ?? null;
    const overlay: CorrespondentCurationEdit = {};
    for (const field of OVERLAY_CONTACT_FIELDS) {
      const value = data[field];
      if (value !== undefined) overlay[field] = value ?? null;
    }
    if (Object.keys(overlay).length > 0) {
      await this.correspondentCurationRepo.upsert(this.workspaceId, id, overlay, editedBy);
    }

    const base: Partial<CorrespondentInsert> = {};
    if (data.email !== undefined) base.email = data.email;
    if (data.last_edited_by_user_id !== undefined) {
      base.last_edited_by_user_id = data.last_edited_by_user_id;
      base.last_edited_at = new Date().toISOString();
    }
    if (Object.keys(base).length > 0) {
      const updated = await this.correspondentRepo.update(
        id,
        base,
        this.workspaceId,
      );
      if (!updated) throw new Error(`Correspondent ${id} not found`);
    }

    const row = await this.correspondentRepo.findById(id, this.workspaceId);
    if (!row) throw new Error(`Correspondent ${id} not found`);
    return row;
  }

  /**
   * "Delete" from the CRM card: unlink the contact from this workspace only.
   * The correspondent row is shared — a hard delete would cascade away every
   * other workspace's overview, deal roles and edits. If a synced mailbox here
   * emails them again, the ingest re-links them like any new correspondent.
   */
  async deleteContact(id: string): Promise<void> {
    const removed = await this.workspaceCorrespondentRepo.removeMembership(
      this.workspaceId,
      id,
    );
    if (!removed) throw new CorrespondentNotFoundError(id);
  }

  // ─── Notes ───────────────────────────────────────────────────────────────

  // Anyone in the workspace may add, edit or delete a firm note. Every change
  // is audited: the repository writes the revision in the same transaction.
  // The acting user comes from the route's session, never from the body.

  async addNote(input: {
    employer_id: string;
    content: string;
    userId: string | null;
  }): Promise<EmployerNote> {
    // Stamped from the service's own workspace context, not trusted from the
    // caller — a route should never be able to write another workspace's note.
    return this.noteRepo.createWithRevision({
      employer_id: input.employer_id,
      workspace_id: this.workspaceId,
      content: input.content,
      author_user_id: input.userId,
    });
  }

  async listNotes(employerId: string): Promise<EmployerNoteListItem[]> {
    return this.noteRepo.findByEmployerId(employerId, this.workspaceId);
  }

  async updateNote(
    id: string,
    content: string,
    userId: string | null,
  ): Promise<EmployerNote> {
    const row = await this.noteRepo.editWithRevision(
      id,
      this.workspaceId,
      content,
      userId,
    );
    if (!row) throw new EmployerNoteNotFoundError(id);
    return row;
  }

  async deleteNote(id: string, userId: string | null): Promise<void> {
    const deleted = await this.noteRepo.softDeleteWithRevision(
      id,
      this.workspaceId,
      userId,
    );
    if (!deleted) throw new EmployerNoteNotFoundError(id);
  }

  async listNoteRevisions(id: string): Promise<EmployerNoteRevisionItem[]> {
    return this.noteRepo.listRevisions(id, this.workspaceId);
  }

  // ─── Topics ──────────────────────────────────────────────────────────────

  async listAllTopics(): Promise<Topic[]> {
    return this.topicRepo.listAll(this.workspaceId);
  }

  async listEmployerTopics(
    employerId: string,
  ): Promise<EmployerTopicAssignment[]> {
    return this.topicRepo.listForEmployer(employerId, this.workspaceId);
  }

  async addTopicToEmployer(
    employerId: string,
    name: string,
    opts: { source?: "auto" | "manual"; is_highlight?: boolean; is_deal_related?: boolean } = {},
  ): Promise<EmployerTopicAssignment[]> {
    const existing = await this.topicRepo.listForEmployer(
      employerId,
      this.workspaceId,
    );
    if (existing.length >= 20) {
      throw new Error("Maximum 20 topics per employer");
    }
    if (
      existing.some((t) => t.name.toLowerCase() === name.toLowerCase())
    ) {
      throw new Error("Topic already attached");
    }
    // A manually-added topic name becomes this workspace's own private topic
    // (not a new shared-vocabulary entry) — see topicRepository.findOrCreate.
    const topic = await this.topicRepo.findOrCreate(
      name,
      { is_deal_related: opts.is_deal_related ?? false },
      this.workspaceId,
    );
    await this.topicRepo.assignToEmployer(employerId, topic.id, this.workspaceId, {
      source: opts.source ?? "manual",
      is_highlight: opts.is_highlight ?? false,
    });
    return this.topicRepo.listForEmployer(employerId, this.workspaceId);
  }

  async reclassifyTopic(
    topicId: string,
    is_deal_related: boolean,
  ): Promise<void> {
    await this.topicRepo.setDealRelated(topicId, is_deal_related);
  }

  async removeTopicFromEmployer(
    employerId: string,
    topicId: string,
  ): Promise<void> {
    await this.topicRepo.removeFromEmployer(employerId, topicId, this.workspaceId);
  }

  // ─── Related companies (manual) ──────────────────────────────────────────

  /**
   * Manually link a company (from `public.companies`) to an employer. The
   * company name is snapshotted from `companies.target`. Rejects if a
   * non-dismissed row already links the same company (auto OR manual) so the
   * tab never shows a user-created duplicate.
   */
  async addRelatedCompanyToEmployer(
    employerId: string,
    companyId: string,
  ): Promise<RelatedCompanyWithEvidence[]> {
    const employer = await this.employerRepo.findById(employerId, this.workspaceId);
    if (!employer) throw new EmployerNotFoundError(employerId);

    const company = await this.companyRepo.findById(companyId);
    if (!company) throw new Error("Company not found");
    const name = (company.target ?? "").trim();
    if (!name) throw new Error("Company has no name");

    const existing = await this.relatedCompanyRepo.findByCompanyId(
      employerId,
      companyId,
      this.workspaceId,
    );
    if (existing.length > 0) throw new Error("Company already linked");

    await this.relatedCompanyRepo.createManual({
      employer_id: employerId,
      workspace_id: this.workspaceId,
      company_id: companyId,
      company_name: name,
      normalized_company_name: normalizeCompanyName(name),
    });
    return dedupeRelatedCompanies(
      await this.relatedCompanyRepo.listForEmployer(employerId, this.workspaceId),
    );
  }

  /**
   * Remove a related company from the card: a manual link is hard-deleted (so
   * it can be re-added), an auto suggestion is dismissed (so the next ingest
   * does not resurrect it). Each repository call is guarded to its own
   * source, so running both is safe and needs no read first.
   */
  async removeRelatedCompanyFromEmployer(
    employerId: string,
    relatedCompanyId: string,
  ): Promise<void> {
    await this.relatedCompanyRepo.deleteManual(
      employerId,
      relatedCompanyId,
      this.workspaceId,
    );
    await this.relatedCompanyRepo.dismissAuto(
      employerId,
      relatedCompanyId,
      this.workspaceId,
    );
  }

  // ─── Team members ────────────────────────────────────────────────────────

  async listTeam(employerId: string): Promise<TeamMember[]> {
    return this.teamRepo.listForEmployer(this.workspaceId, employerId);
  }

  /**
   * Replace this workspace's coverage of a firm. Only members of this
   * workspace may be ADDED — anyone else's name would show on the card. A
   * person already on this firm's team here (an ex-member, or a row the
   * ingest wrote) may stay, so saving an unrelated change never fails on them.
   */
  async setTeam(employerId: string, userIds: string[]): Promise<TeamMember[]> {
    const wanted = [...new Set(userIds)];
    if (wanted.length > 0) {
      const [members, current] = await Promise.all([
        this.teamRepo.listWorkspaceMembers(this.workspaceId),
        this.teamRepo.listForEmployer(this.workspaceId, employerId),
      ]);
      const allowed = new Set([...members, ...current].map((m) => m.id));
      const outsiders = wanted.filter((id) => !allowed.has(id));
      if (outsiders.length > 0) throw new InvalidTeamMemberError(outsiders);
    }
    await this.teamRepo.setMembers(this.workspaceId, employerId, wanted);
    return this.teamRepo.listForEmployer(this.workspaceId, employerId);
  }

  async listAllTeamUsers(): Promise<TeamMember[]> {
    return this.teamRepo.listAllTeamUsers();
  }

  /** Who the team picker may assign: this workspace's members only. */
  async listWorkspaceMembers(): Promise<TeamMember[]> {
    return this.teamRepo.listWorkspaceMembers(this.workspaceId);
  }

  // ─── Primary contact (PIC) ───────────────────────────────────────────────

  /**
   * Pick the firm's PIC for this workspace, or `null` to go back to the
   * default (its oldest visible contact). The contact must be visible here and
   * work at this firm — otherwise one workspace could point its PIC at a
   * person it cannot see.
   *
   * A teammate picking a contact also queues Get Full Profile for them when
   * it is worth a run (`CrmContactEnrichmentService.enrichNewPrimary`). The
   * pick is already saved by then, so a queue failure is logged, not thrown.
   */
  async setPrimaryContact(
    employerId: string,
    correspondentId: string | null,
    editedBy: string | null,
  ): Promise<void> {
    if (correspondentId !== null) {
      const contact = await this.correspondentRepo.findById(
        correspondentId,
        this.workspaceId,
      );
      if (!contact || contact.employer_id !== employerId) {
        throw new CorrespondentNotFoundError(correspondentId);
      }
    }
    await this.employerCurationRepo.upsert(
      this.workspaceId,
      employerId,
      { primary_correspondent_id: correspondentId },
      editedBy,
    );
    if (correspondentId === null || !this.contactEnrichment) return;
    try {
      await this.contactEnrichment.enrichNewPrimary(correspondentId, editedBy);
    } catch (err) {
      console.error("[crm] auto profile for new primary contact failed:", err);
    }
  }

  // ─── Insights ────────────────────────────────────────────────────────────

  async insights(ctx: InsightsContext = {}): Promise<CRMInsights> {
    const now = Date.now();
    const staleThreshold = new Date(now - STALE_DAYS * DAY_MS).toISOString();
    let todayStartIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    if (ctx.clientTodayIso) {
      todayStartIso = ctx.clientTodayIso;
    }
    
    const [stale, flagged, todayCount, lastSyncedAt, custodianCount] = await Promise.all([
      this.emailRepo.countStaleEmployers(staleThreshold, this.workspaceId),
      this.employerRepo.countFlagged(this.workspaceId),
      this.emailRepo.countSince(todayStartIso, this.workspaceId),
      this.vaultSync ? this.vaultSync.vaultExportRepo.findLastArchivedAt() : null,
      this.vaultSync
        ? this.vaultSync.userWorkspaceRepo.countSyncedCustodians(this.workspaceId)
        : null,
    ]);
    const nextSyncAt = lastSyncedAt
      ? new Date(new Date(lastSyncedAt).getTime() + VAULT_SYNC_CADENCE_MS).toISOString()
      : null;
    return {
      stale_employers: stale,
      flagged_records: flagged,
      emails_today: todayCount,
      email_accounts: custodianCount,
      last_synced_at: lastSyncedAt,
      next_sync_at: nextSyncAt,
    };
  }

  async listFlaggedEmployers(): Promise<Employer[]> {
    return this.employerRepo.listFlagged(this.workspaceId);
  }

  /**
   * Flagged employers enriched with their primary correspondent so the
   * curation modal can render and edit PIC fields without a second round-trip
   * per record.
   */
  async listFlaggedEmployerDetails(): Promise<
    Array<{
      id: string;
      name: string;
      industry: string | null;
      status: string;
      primary_pic: {
        id: string;
        name: string;
        title: string | null;
        email: string | null;
        phone: string | null;
      } | null;
    }>
  > {
    const flagged = await this.employerRepo.listFlagged(this.workspaceId);
    // One batched correspondent read for all flagged employers instead of a
    // per-employer query (was an N+1). Group by employer_id in memory.
    const correspondents = await this.correspondentRepo.findByEmployerIds(
      flagged.map((emp) => emp.id),
      this.workspaceId,
    );
    type Corr = (typeof correspondents)[number];
    const byEmployer = new Map<string, Corr[]>();
    for (const c of correspondents) {
      const list = byEmployer.get(c.employer_id);
      if (list) list.push(c);
      else byEmployer.set(c.employer_id, [c]);
    }
    return flagged.map((emp) => {
      const list = byEmployer.get(emp.id) ?? [];
      const primary = list.find((c) => c.is_primary) ?? list[0] ?? null;
      return {
        id: emp.id,
        name: emp.name,
        industry: emp.industry,
        status: emp.status,
        primary_pic: primary
          ? {
              id: primary.id,
              name: primary.name,
              title: primary.title,
              email: primary.email,
              phone: primary.phone,
            }
          : null,
      };
    });
  }

  // ─── Email ingestion (Vault sync + file uploads) ────────────────────────

  async ingestEmails(
    rows: Array<{
      from_email: string;
      from_name?: string;
      to_email?: string;
      to_name?: string;
      sent_at?: string;
      direction: "inbound" | "outbound";
      /** Free-text company / firm name extracted from the email. */
      company?: string;
    }>,
  ): Promise<{ employers_created: number; emails_added: number }> {
    let employersCreated = 0;
    let emailsAdded = 0;

    for (const row of rows) {
      const firmName = row.company?.trim() || domainOf(row.from_email);
      if (!firmName) continue;

      let employer = await this.employerRepo.findByNormalizedName(
        normalizeName(firmName),
      );
      if (!employer) {
        employer = await this.employerRepo.insert({
          name: firmName,
          normalized_name: normalizeName(firmName),
          status: "inbound",
          curation_status: "published",
        });
        employersCreated++;
      }

      const fromCorrespondent = await this.upsertCorrespondent(employer.id, {
        email: row.from_email,
        name: row.from_name,
      });

      const email = await this.emailRepo.insert({
        employer_id: employer.id,
        from_address: row.from_email,
        from_display_name: row.from_name,
        sent_at: row.sent_at ?? new Date().toISOString(),
        direction: row.direction,
        filter_status: "processed",
        processed_at: new Date().toISOString(),
      });

      const participants: Parameters<
        EmailRepository["insertParticipants"]
      >[0] = [
        {
          email_id: email.id,
          address: row.from_email,
          display_name: row.from_name,
          correspondent_id: fromCorrespondent?.id,
          role: "from",
        },
      ];
      if (row.to_email) {
        participants.push({
          email_id: email.id,
          address: row.to_email,
          display_name: row.to_name,
          role: "to",
        });
      }
      await this.emailRepo.insertParticipants(participants);
      emailsAdded++;
    }

    return { employers_created: employersCreated, emails_added: emailsAdded };
  }

  // "direct", not "ingest" — this path (Google Vault export / file-extracted
  // communications, called from vaultExport.ts/fileService.ts) has no mailbox
  // or message_id at all, unlike crmIngest's real mailbox-sync pipeline, so
  // the membership records where the link actually came from. Provenance
  // only: no read gates on `source` any more (they used to hide 'ingest' rows
  // from a workspace with no email-synced member — see
  // CorrespondentRepository.visibleCorrespondentIds).
  private async upsertCorrespondent(
    employerId: string,
    data: { email?: string; name?: string },
  ): Promise<Correspondent | null> {
    const email = normalizeEmail(data.email);
    if (!email) return null;
    // Join on email alone so an ingested address links to a contact a human
    // already added under a different firm.
    const existing = pickCanonicalByEmail(
      await this.correspondentRepo.findByEmails([email]),
      employerId,
    ).get(email);
    if (existing) {
      await this.workspaceCorrespondentRepo.addMembership(
        this.workspaceId,
        existing.id,
        "direct",
      );
      return existing;
    }
    const created = await this.correspondentRepo.insert(
      {
        employer_id: employerId,
        name: data.name?.trim() || email,
        email,
        source: "auto",
        is_primary: false,
      },
      this.workspaceId,
    );
    await this.workspaceCorrespondentRepo.addMembership(
      this.workspaceId,
      created.id,
      "direct",
    );
    return created;
  }
}

/**
 * One contact per lowercased email out of `findByEmails` rows (already ordered
 * manual-first, oldest-first). A row under `preferEmployerId` wins over that
 * order, so re-adding a contact on the card it already sits on stays put.
 */
function pickCanonicalByEmail(
  rows: Correspondent[],
  preferEmployerId?: string,
): Map<string, Correspondent> {
  const out = new Map<string, Correspondent>();
  for (const row of rows) {
    const key = normalizeEmail(row.email);
    if (!key) continue;
    const current = out.get(key);
    if (
      !current ||
      (preferEmployerId &&
        row.employer_id === preferEmployerId &&
        current.employer_id !== preferEmployerId)
    ) {
      out.set(key, row);
    }
  }
  return out;
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== ""),
  ) as Partial<T>;
}

/** An import row's human-editable fields, as a curation overlay edit. */
function overlayOf(row: ImportContactRow): CorrespondentCurationEdit {
  return definedOnly({
    name: row.name,
    title: row.title,
    phone: row.phone,
    type: row.type,
    department: row.department,
    specialization: row.specialization,
    seniority: row.seniority,
    coverage_region: row.coverageRegion,
    linkedin_url: row.linkedinUrl,
    bio: row.bio,
  });
}

function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 0) return null;
  return email
    .slice(at + 1)
    .replace(/^(www\.)/i, "")
    .replace(/\.(com|net|org|io|co|ai|id|sg|jp|kr|cn|tw|hk|uk|de|fr|es|it|nl|au|nz|in|ca|us|eu)(\..+)?$/i, "")
    .trim();
}
