import type {
  CompanyRepository,
  Correspondent,
  CorrespondentInsert,
  CorrespondentCurationRepository,
  CorrespondentRepository,
  EmailRepository,
  Employer,
  EmployerCurationRepository,
  EmployerListFilters,
  EmployerNote,
  EmployerNoteInsert,
  EmployerNoteRepository,
  EmployerRelatedCompanyRanking,
  EmployerRelatedCompanyRepository,
  EmployerRepository,
  EmployerSummary,
  EmployerTeamRepository,
  EmployerTopicAssignment,
  EmployerUpdate,
  RelatedCompanyWithEvidence,
  TeamMember,
  Topic,
  TopicRepository,
  WorkspaceCorrespondentRepository,
} from "@/lib/repositories";
import { normalizeCompanyName } from "@/lib/crm/normalizeCompanyName";

export class DuplicateEmployerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateEmployerError";
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
  correspondents: Correspondent[];
  notes: EmployerNote[];
  topics: EmployerTopicAssignment[];
  team: TeamMember[];
  email_count: number;
  last_contact_at: string | null;
  related_companies: RelatedCompanyWithEvidence[];
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
  /** Count of Vault custodian mailboxes — surfaced in the header subtitle. */
  vaultCustodianCount?: number;
  /** ISO timestamp of the last successful Vault sync job. */
  lastVaultSyncedAt?: string | null;
  /** Milliseconds between scheduled Vault syncs. */
  vaultSyncCadenceMs?: number;
  /** Client's today timestamp in ISO format for time-relative insights. */
  clientTodayIso?: string;
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
  isPrimary?: boolean;
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  ) {}

  // ─── Employers ───────────────────────────────────────────────────────────

  async listEmployers(
    filters: EmployerListFilters = {},
  ): Promise<{ data: EmployerSummary[]; total: number }> {
    const [data, total] = await Promise.all([
      this.employerRepo.list(filters, this.workspaceId),
      this.employerRepo.count(filters, this.workspaceId),
    ]);
    return { data, total };
  }

  async getEmployerDetail(id: string): Promise<EmployerDetail> {
    const employer = await this.employerRepo.findById(id);
    if (!employer) throw new EmployerNotFoundError(id);

    const [correspondents, notes, topics, team, emailCount, emails, relatedCompanies] =
      await Promise.all([
        this.correspondentRepo.findByEmployerId(id, this.workspaceId),
        this.noteRepo.findByEmployerId(id, this.workspaceId),
        this.topicRepo.listForEmployer(id, this.workspaceId),
        this.teamRepo.listForEmployer(id),
        this.emailRepo.countByEmployer(id),
        this.emailRepo.findByEmployerId(id, { limit: 1 }),
        this.relatedCompanyRepo.listForEmployer(id, this.workspaceId),
      ]);

    const primary_pic =
      correspondents.find((c) => c.is_primary) ?? correspondents[0] ?? null;

    return {
      employer,
      primary_pic,
      correspondents,
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
      await this.employerCurationRepo.upsert(id, overlay, null);
    }

    const base: EmployerUpdate = {};
    if (data.status !== undefined) base.status = data.status;
    if (data.curation_status !== undefined) base.curation_status = data.curation_status;
    if (Object.keys(base).length > 0) {
      const updated = await this.employerRepo.update(id, base);
      if (!updated) throw new EmployerNotFoundError(id);
    }

    const effective = await this.employerRepo.findById(id);
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
      await this.employerCurationRepo.upsert(id, overlay, null);
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

    return this.employerRepo.findById(id) as Promise<Employer>;
  }

  // ─── Correspondents ──────────────────────────────────────────────────────

  async createContact(input: CreateContactInput): Promise<Correspondent> {
    if (!input.employerId && !input.firmName) {
      throw new Error("employerId or firmName is required");
    }

    const employer = input.employerId
      ? await this.employerRepo.findById(input.employerId)
      : await this.findOrCreateEmployer(input.firmName!);

    if (!employer) {
      throw new EmployerNotFoundError(input.employerId ?? "(unknown)");
    }

    if (input.email) {
      const dupe = await this.correspondentRepo.findByEmployerAndEmail(
        employer.id,
        input.email,
      );
      if (dupe) {
        // Adding a contact that already exists (by email) = a human edit of the
        // existing row → goes to the overlay via updateContact. Also ensures
        // this workspace gets a membership row, so re-adding a contact that
        // was only visible to another workspace makes it visible here too.
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
        });
      }
    }

    const created = await this.correspondentRepo.insert(
      {
        employer_id: employer.id,
        name: input.name,
        email: input.email,
        phone: input.phone,
        title: input.title,
        type: input.type,
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

  async listContacts(employerId: string): Promise<Correspondent[]> {
    return this.correspondentRepo.findByEmployerId(employerId, this.workspaceId);
  }

  async updateContact(
    id: string,
    data: Partial<CorrespondentInsert>,
  ): Promise<Correspondent> {
    // Split: name/title/phone/type are machine-derived → overlay.
    // email (the natural key) and last_edited_* stay on the base table.
    const editedBy = data.last_edited_by_user_id ?? null;
    const overlay: {
      name?: string | null;
      title?: string | null;
      phone?: string | null;
      type?: string | null;
    } = {};
    if (data.name !== undefined) overlay.name = data.name;
    if (data.title !== undefined) overlay.title = data.title;
    if (data.phone !== undefined) overlay.phone = data.phone;
    if (data.type !== undefined) overlay.type = data.type;
    if (Object.keys(overlay).length > 0) {
      await this.correspondentCurationRepo.upsert(id, overlay, editedBy);
    }

    const base: Partial<CorrespondentInsert> = {};
    if (data.email !== undefined) base.email = data.email;
    if (data.last_edited_by_user_id !== undefined) {
      base.last_edited_by_user_id = data.last_edited_by_user_id;
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

  async deleteContact(id: string): Promise<void> {
    await this.correspondentRepo.delete(id, this.workspaceId);
  }

  // ─── Notes ───────────────────────────────────────────────────────────────

  async addNote(
    input: Omit<EmployerNoteInsert, "workspace_id">,
  ): Promise<EmployerNote> {
    // Stamped from the service's own workspace context, not trusted from the
    // caller — a route should never be able to write another workspace's note.
    return this.noteRepo.insert({ ...input, workspace_id: this.workspaceId });
  }

  async listNotes(employerId: string): Promise<EmployerNote[]> {
    return this.noteRepo.findByEmployerId(employerId, this.workspaceId);
  }

  async deleteNote(id: string): Promise<void> {
    await this.noteRepo.delete(id, this.workspaceId);
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
    await this.topicRepo.assignToEmployer(employerId, topic.id, {
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
    await this.topicRepo.removeFromEmployer(employerId, topicId);
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
    const employer = await this.employerRepo.findById(employerId);
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

  /** Hard-delete a manual related company link. No-op for auto rows. */
  async removeRelatedCompanyFromEmployer(
    employerId: string,
    relatedCompanyId: string,
  ): Promise<void> {
    await this.relatedCompanyRepo.deleteManual(
      employerId,
      relatedCompanyId,
      this.workspaceId,
    );
  }

  // ─── Team members ────────────────────────────────────────────────────────

  async listTeam(employerId: string): Promise<TeamMember[]> {
    return this.teamRepo.listForEmployer(employerId);
  }

  async setTeam(employerId: string, userIds: string[]): Promise<TeamMember[]> {
    await this.teamRepo.setMembers(employerId, userIds);
    return this.teamRepo.listForEmployer(employerId);
  }

  async listAllTeamUsers(): Promise<TeamMember[]> {
    return this.teamRepo.listAllTeamUsers();
  }

  // ─── Insights ────────────────────────────────────────────────────────────

  async insights(ctx: InsightsContext = {}): Promise<CRMInsights> {
    const now = Date.now();
    const staleThreshold = new Date(now - STALE_DAYS * DAY_MS).toISOString();
    let todayStartIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    if (ctx.clientTodayIso) {
      todayStartIso = ctx.clientTodayIso;
    }
    
    const [stale, flagged, todayCount] = await Promise.all([
      this.emailRepo.countStaleEmployers(staleThreshold, this.workspaceId),
      this.employerRepo.countFlagged(this.workspaceId),
      this.emailRepo.countSince(todayStartIso, this.workspaceId),
    ]);
    const lastSyncedAt = ctx.lastVaultSyncedAt ?? null;
    const nextSyncAt =
      lastSyncedAt && ctx.vaultSyncCadenceMs
        ? new Date(
            new Date(lastSyncedAt).getTime() + ctx.vaultSyncCadenceMs,
          ).toISOString()
        : null;
    return {
      stale_employers: stale,
      flagged_records: flagged,
      emails_today: todayCount,
      email_accounts: ctx.vaultCustodianCount ?? null,
      last_synced_at: lastSyncedAt,
      next_sync_at: nextSyncAt,
    };
  }

  async listFlaggedEmployers(): Promise<Employer[]> {
    return this.employerRepo.listFlagged();
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
    const flagged = await this.employerRepo.listFlagged();
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
      subject?: string;
      body: string;
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
        subject: row.subject,
        body_text: row.body,
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
  // communications, called from vaultExport.ts/fileService.ts) has no
  // mailbox or message_id at all and is never governed by
  // user_workspaces.is_email_synced, unlike crmIngest's real mailbox-sync
  // pipeline. Labeling it "ingest" would let the sync gate hide it
  // permanently for a workspace with no currently-synced member, even
  // though this content was never tied to mailbox sync in the first place.
  private async upsertCorrespondent(
    employerId: string,
    data: { email?: string; name?: string },
  ): Promise<Correspondent | null> {
    if (!data.email) return null;
    const existing = await this.correspondentRepo.findByEmployerAndEmail(
      employerId,
      data.email,
    );
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
        name: data.name?.trim() || data.email,
        email: data.email,
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

function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 0) return null;
  return email
    .slice(at + 1)
    .replace(/^(www\.)/i, "")
    .replace(/\.(com|net|org|io|co|ai|id|sg|jp|kr|cn|tw|hk|uk|de|fr|es|it|nl|au|nz|in|ca|us|eu)(\..+)?$/i, "")
    .trim();
}
