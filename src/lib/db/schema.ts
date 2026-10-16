import {
  pgTable,
  pgSchema,
  pgView,
  index,
  uniqueIndex,
  pgPolicy,
  uuid,
  jsonb,
  text,
  integer,
  bigint,
  bigserial,
  timestamp,
  foreignKey,
  unique,
  check,
  numeric,
  char,
  varchar,
  boolean,
  date,
  pgEnum,
  primaryKey,
  real,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// MB-205: the analytics schema holds the recomputable / machine-owned data
// plane — raw layer, email facts, mbox-pipeline state, and the marts. Declared
// up here because table definitions below attach to it.
export const analytics = pgSchema("analytics");

export const analysisJobStatus = pgEnum("analysis_job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);
export const companyStatus = pgEnum("company_status", ["active", "dropped"]);
export const dealOrigin = pgEnum("deal_origin", ["inbound", "outbound"]);
// Kept in lockstep with `DEAL_TYPES` in `@/lib/companies/dealTypes`, which
// carries the display labels and the free-text normalizer; `dealTypes.test.ts`
// asserts the two lists match. Widening it needs an `ALTER TYPE … ADD VALUE`
// migration — see 20261007000001_add_investment_banking_deal_types.sql.
export const dealType = pgEnum("deal_type", [
  "majority",
  "minority",
  "public_market",
  "bond_issuance",
  "ipo",
  "follow_on_offering",
  "private_placement",
  "equity_crowdfunding",
  "debt_financing",
  "ma_advisory",
  "restructuring",
  "joint_venture",
]);
export const jobStatus = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "timed_out",
]);
export const jobType = pgEnum("job_type", [
  "slide_generation",
  "market_screening",
  "ai_screening",
  "company_analysis",
  "stuck_cleanup",
  "graph_sync",
  "track_matching",
  "fund_update_extraction",
  "deal_document_processing",
  "company_vote",
  "pending_auto_scan",
]);
export const l1Result = pgEnum("l1_result", ["pass", "fail", "inconclusive"]);
export const screeningState = pgEnum("screening_state", [
  "pending",
  "completed",
  "failed",
]);

// AI Workforce (MB-143)
export const workforceStatus = pgEnum("workforce_status", [
  "pending",
  "running",
  "waiting_for_human_input",
  "waiting_for_subagent",
  "resume_ready",
  "succeeded",
  "failed",
  "rejected",
  "timed_out",
]);

export const triggerSource = pgEnum("trigger_source", [
  "chat",
  "cron",
  "webhook",
  "api",
]);

export const scheduleKind = pgEnum("schedule_kind", [
  "daily",
  "weekly",
  "monthly",
  "cron",
]);

// Company voting (Investment Committee style vote on a single company).
// `vote_session_status`: an `active` session is open for ballots until it is
// `completed` (everyone submitted, or the deadline swept it) or `cancelled` by
// its initiator. `vote_choice` is the five-point scale the UI offers.
// `vote_ballot_status`: a ballot stays `draft` — freely editable — until the
// voter submits it, after which it is immutable (unless the initiator sends
// submissions back, which flips it to `draft` again).
export const voteSessionStatus = pgEnum("vote_session_status", [
  "active",
  "completed",
  "cancelled",
]);

export const voteChoice = pgEnum("vote_choice", [
  "hard_yes",
  "yes",
  "no",
  "inconclusive",
  "hard_no",
]);

export const voteBallotStatus = pgEnum("vote_ballot_status", [
  "draft",
  "submitted",
]);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    type: jobType().notNull(),
    status: jobStatus().default("pending").notNull(),
    payload: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    result: jsonb().$type<unknown>(),
    error: text(),
    timeout_seconds: integer().default(480).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    started_at: timestamp({ withTimezone: true, mode: "string" }),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    workspace_id: uuid().references((): AnyPgColumn => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (table) => {
    return {
      idxJobsCreatedAt: index("idx_jobs_created_at").using(
        "btree",
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxJobsStatus: index("idx_jobs_status").using(
        "btree",
        table.status.asc().nullsLast().op("enum_ops"),
      ),
      idxJobsType: index("idx_jobs_type").using(
        "btree",
        table.type.asc().nullsLast().op("enum_ops"),
      ),
      idxJobsWorkspaceId: index("idx_jobs_workspace_id").using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
      ),
      allowDeleteAccessOnJobs: pgPolicy("Allow delete access on jobs", {
        as: "permissive",
        for: "delete",
        to: ["public"],
        using: sql`true`,
      }),
      allowUpdateAccessOnJobs: pgPolicy("Allow update access on jobs", {
        as: "permissive",
        for: "update",
        to: ["public"],
      }),
      allowInsertAccessOnJobs: pgPolicy("Allow insert access on jobs", {
        as: "permissive",
        for: "insert",
        to: ["public"],
      }),
      allowReadAccessOnJobs: pgPolicy("Allow read access on jobs", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

export const jobLogs = pgTable(
  "job_logs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    job_id: uuid().notNull(),
    from_status: jobStatus(),
    to_status: jobStatus().notNull(),
    message: text(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxJobLogsCreatedAt: index("idx_job_logs_created_at").using(
        "btree",
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxJobLogsJobId: index("idx_job_logs_job_id").using(
        "btree",
        table.job_id.asc().nullsLast().op("uuid_ops"),
      ),
      jobLogsJobIdFkey: foreignKey({
        columns: [table.job_id],
        foreignColumns: [jobs.id],
        name: "job_logs_job_id_fkey",
      }).onDelete("cascade"),
      allowInsertAccessOnJobLogs: pgPolicy("Allow insert access on job_logs", {
        as: "permissive",
        for: "insert",
        to: ["public"],
        withCheck: sql`true`,
      }),
      allowReadAccessOnJobLogs: pgPolicy("Allow read access on job_logs", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

export const criterias = pgTable(
  "criterias",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    prompt: text().notNull(),
    // The Track (investment_thesis) this screening criterion belongs to.
    investment_thesis_id: uuid()
      .notNull()
      .references((): AnyPgColumn => investmentThesis.id, {
        onDelete: "cascade",
      }),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxCriteriasInvestmentThesisId: index(
        "idx_criterias_investment_thesis_id",
      ).using(
        "btree",
        table.investment_thesis_id.asc().nullsLast().op("uuid_ops"),
      ),
      allowDeleteAccessOnCriterias: pgPolicy(
        "Allow delete access on criterias",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnCriterias: pgPolicy(
        "Allow update access on criterias",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnCriterias: pgPolicy(
        "Allow insert access on criterias",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnCriterias: pgPolicy("Allow read access on criterias", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

/** How a track variable's value is captured on the Company Card. */
export type TrackVariableType = "textbox" | "radio";

/**
 * Per-company values for Track variables, nested by track id then variable id:
 * `{ [trackId]: { [variableId]: value } }`.
 */
export type TrackSpecificVariables = Record<string, Record<string, string>>;

export const trackVariables = pgTable(
  "track_variables",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // The Track (investment_thesis) this variable belongs to.
    track_id: uuid()
      .notNull()
      .references((): AnyPgColumn => investmentThesis.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    // Display unit, e.g. percentage, tonne, currency. Free-text.
    unit: text(),
    // 'textbox' | 'radio' — how the value is captured on the Company Card.
    type: text().$type<TrackVariableType>().default("textbox").notNull(),
    // Choices for 'radio' type variables (ignored for 'textbox').
    options: jsonb().$type<string[]>().default([]),
    sort_order: integer().default(0),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxTrackVariablesTrackId: index("idx_track_variables_track_id").using(
        "btree",
        table.track_id.asc().nullsLast().op("uuid_ops"),
      ),
    };
  },
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    // Which AI Copilot flavor this workspace uses: "mna" (M&A / acquisitions —
    // the default), "investment" (funds & investing), or "combined" (both tool
    // sets in one assistant). Read by the chat route to pick the agent graph;
    // set from the workspace configuration dropdown.
    copilot_agent: text().default("mna").notNull(),
    // Workspace-wide display currency ("USD" | "IDR" | "CNY"). Relabels money
    // formatting across Fund Management and the Revenue/EBITDA/EV columns; it
    // does NOT convert stored values. Read into the client via
    // WorkspaceCurrencyProvider in the /w/[slug] layout.
    default_currency: text().default("USD").notNull(),
    // Heading shown at the top of the Deal Pipeline page, editable in place by
    // any member. NULL (the default) means "use the product default" —
    // "Deal Pipeline" / "Track companies through all stages" — so an untouched
    // workspace renders the original copy and clearing a field restores it.
    // Read into the client via PipelineHeadingProvider in the /w/[slug] layout.
    pipeline_title: text(),
    pipeline_subtitle: text(),
    // Sourcing → Pending Confirmation automation, toggled by any member.
    // `pending_auto_scan`: a company entering Pending Confirmation is matched
    // to tracks and AI-screened against their criteria. `pending_auto_drop_promote`:
    // after that scan, an overall pass promotes it to L0 and a fail drops it.
    // Only meaningful while auto-scan is on (the service forces it off otherwise).
    pending_auto_scan: boolean().default(false).notNull(),
    pending_auto_drop_promote: boolean().default(false).notNull(),
    // Soft delete. Non-null = the workspace is archived: it disappears from
    // the workspace picker/switcher, from every membership listing, and from
    // background sweeps (cron, graph sync), and `/w/<slug>/...` bounces back
    // to `/workspace`. The row itself is kept, so the slug stays taken (the
    // unique constraint below is deliberately NOT partial) and a superadmin
    // can reinstate the workspace with its data intact.
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => {
    return {
      workspacesSlugKey: unique("workspaces_slug_key").on(table.slug),
      idxWorkspacesDeletedAt: index("idx_workspaces_deleted_at").using(
        "btree",
        table.deleted_at.asc().nullsLast().op("timestamptz_ops"),
      ),
    };
  },
);

export const roles = pgTable(
  "roles",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => {
    return {
      rolesNameKey: unique("roles_name_key").on(table.name),
    };
  },
);

export const companies = pgTable(
  "companies",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    entry_id: integer(),
    watchlist_id: integer(),
    segment: text(),
    target: text(),
    project_name: text(),
    segment_related_offerings: text(),
    company_focus: text(),
    website: text(),
    watchlist_status: text(),
    comments: text(),
    ownership: text(),
    geography: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    // A stage key. The pre-pipeline buckets (`market_screening`, `unreviewed`
    // — companies auto-created from email attachments, pending triage — and
    // `discovered` — one side of a relationship-graph edge) are fixed; every
    // other value is a key from this workspace's `pipeline_stages`. Text, not
    // the old `pipeline_stage` enum, so workspaces can add their own stages.
    pipeline_stage: text().default("L0").notNull(),
    remarks: text(),
    thesis_content: text(),
    // Free-form markdown background a human (or the workforce at intake) writes
    // about the company — the "Context" tab on the company card. Read by the AI
    // Opinion run, the slide/company-card generators and the agent read tools,
    // so it carries weight the structured columns can't express.
    context: text(),
    source: dealOrigin(),
    status: companyStatus().default("active").notNull(),
    dropped_reason: text(),
    dropped_at: timestamp({ withTimezone: true, mode: "string" }),
    // Optional scheduled resurfacing of a dropped deal. When set, the
    // resurface cron reactivates the deal at this time, appends an
    // explanatory note, and emails the PIC + the user who dropped it.
    resurface_at: timestamp({ withTimezone: true, mode: "string" }),
    // User who dropped the deal — notified when the deal resurfaces.
    dropped_by: uuid().references(() => users.id, { onDelete: "set null" }),
    promoted_reasons: text(),
    // Pipeline (HTML-parity) fields — inbound first.
    deal_type: dealType().default("majority"),
    // UUID of the user who sourced this company (references users.id).
    // Set to the mailbox owner for email-pipeline auto-creates, or the
    // uploading user for manual Smart Files entries.
    entered_by: uuid().references(() => users.id, { onDelete: 'set null' }),
    originator: text(),
    // Deal Sponsor (shown at L0–L2) and Deal Captain (shown at L3+) — UUIDs of
    // the responsible users (reference users.id). Override the matched Track's
    // PIC per company; empty falls back to the Track PIC for display. Deal
    // Captain inherits Deal Sponsor on promotion into L3+.
    deal_sponsor: uuid().references(() => users.id, { onDelete: 'set null' }),
    deal_captain: uuid().references(() => users.id, { onDelete: 'set null' }),
    last_activity_at: timestamp({ withTimezone: true, mode: "string" }),
    banker: text(),
    // Deal advisor (a banker engaged on the deal). Populated from the existing
    // list of banker names. A non-empty advisor means the deal is "live".
    advisor: text(),
    // doc_type values are constrained in the app UI only (not a DB enum).
    doc_type: text(),
    // NBO (Non-Binding Offer) due date. A live deal (non-empty advisor) usually
    // carries an NBO date; surfaced on the company card and pipeline tables.
    nbo_date: date(),
    // Explicit override for the "live process" status. NULL ⇒ derive from the
    // presence of an advisor; TRUE/FALSE force the status regardless. See
    // isDealLive() in src/lib/dealStatus.ts.
    is_live: boolean(),
    stake: text(),
    deal_size: text(),
    // Free-text pipeline workflow status (inbound or outbound — source
    // disambiguates). Stored values surface as reusable dropdown options on
    // the FE; not constrained to an enum.
    workflow_status: text(),
    // Outbound-specific fields.
    key_rationale: text(),
    banker_source: text(),
    possible_duplicate_company_id: uuid(),
    // Investment-thesis ("Track") ids this company is manually matched to.
    // Empty array → the UI falls back to auto-suggested tracks.
    matched_track_ids: jsonb().$type<string[]>().default([]),
    // Per-Track custom variable values, nested by track id then variable id:
    // { [trackId]: { [variableId]: value } }.
    track_specific_variables: jsonb()
      .$type<TrackSpecificVariables>()
      .default({}),
    // Track variable ids (track_variables.id) the user has opted to surface on
    // the Company Card slide deck under "Indicative Financials".
    slide_track_variable_ids: jsonb().$type<string[]>().default([]),
    // Alternative names this company is known by. Populated when companies are
    // combined (the absorbed companies' names/aliases roll up here) and consulted
    // by fuzzy name matching so a relationship edge or ingest naming an alias
    // resolves to this company instead of creating a duplicate.
    aliases: jsonb().$type<string[]>().default([]),
    // AI Opinion: a firm PASS/FAIL/TENTATIVE verdict + ≤50-word rationale
    // produced by an AI Workforce run, surfaced as the right-most pipeline
    // column. `ai_opinion_status` tracks the in-flight run lifecycle
    // ('processing' | 'completed' | 'failed').
    ai_opinion_verdict: text(),
    ai_opinion_summary: text(),
    ai_opinion_status: text(),
    ai_opinion_updated_at: timestamp({ withTimezone: true, mode: "string" }),
    // Pending Confirmation auto-scan queue. Non-null = a match → screen →
    // (optional) drop/promote pass is waiting for the per-minute
    // `/api/cron/pending-auto-scan` drain, which clears it when it claims the
    // row. `auto_scan_force` re-screens criteria that already have a result
    // (the Scan now button); otherwise completed screenings are kept.
    auto_scan_requested_at: timestamp({ withTimezone: true, mode: "string" }),
    auto_scan_force: boolean().default(false).notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => {
    return {
      idxCompaniesAutoScanRequestedAt: index("idx_companies_auto_scan_requested_at")
        .using("btree", table.auto_scan_requested_at.asc().nullsLast())
        .where(sql`auto_scan_requested_at IS NOT NULL`),
      idxCompaniesWorkspaceId: index("idx_companies_workspace_id").using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxCompaniesEntryId: index("idx_companies_entry_id").using(
        "btree",
        table.entry_id.asc().nullsLast().op("int4_ops"),
      ),
      idxCompaniesGeography: index("idx_companies_geography").using(
        "btree",
        table.geography.asc().nullsLast().op("text_ops"),
      ),
      idxCompaniesOwnership: index("idx_companies_ownership").using(
        "btree",
        table.ownership.asc().nullsLast().op("text_ops"),
      ),
      idxCompaniesPipelineStage: index("idx_companies_pipeline_stage").using(
        "btree",
        table.pipeline_stage.asc().nullsLast().op("text_ops"),
      ),
      idxCompaniesSegment: index("idx_companies_segment").using(
        "btree",
        table.segment.asc().nullsLast().op("text_ops"),
      ),
      idxCompaniesSource: index("idx_companies_source").using(
        "btree",
        table.source.asc().nullsLast().op("enum_ops"),
      ),
      idxCompaniesStatus: index("idx_companies_status").using(
        "btree",
        table.status.asc().nullsLast().op("enum_ops"),
      ),
      idxCompaniesResurfaceDue: index("idx_companies_resurface_due")
        .using("btree", table.resurface_at.asc().nullsLast())
        .where(
          sql`${table.status} = 'dropped' AND ${table.resurface_at} IS NOT NULL`,
        ),
      idxCompaniesTarget: index("idx_companies_target").using(
        "btree",
        table.target.asc().nullsLast().op("text_ops"),
      ),
      companiesPossibleDuplicateFkey: foreignKey({
        columns: [table.possible_duplicate_company_id],
        foreignColumns: [table.id],
        name: "companies_possible_duplicate_fkey",
      }).onDelete("set null"),
      idxCompaniesWatchlistId: index("idx_companies_watchlist_id").using(
        "btree",
        table.watchlist_id.asc().nullsLast().op("int4_ops"),
      ),
      idxCompaniesWatchlistStatus: index(
        "idx_companies_watchlist_status",
      ).using("btree", table.watchlist_status.asc().nullsLast().op("text_ops")),
      allowDeleteAccessOnCompanies: pgPolicy(
        "Allow delete access on companies",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnCompanies: pgPolicy(
        "Allow update access on companies",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnCompanies: pgPolicy(
        "Allow insert access on companies",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnCompanies: pgPolicy("Allow read access on companies", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    password: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    email: text(),
    role: text(),
    // Platform-wide superadmin flag — grants admin-portal access (create
    // workspaces, manage members/roles) across every workspace, independent
    // of any user_workspaces membership. Not to be confused with `role`
    // above (a free-text job title) or the per-workspace admin/editor/viewer
    // role on user_workspaces.role_id (in-workspace only).
    is_superadmin: boolean().default(false).notNull(),
    // Soft "deactivate", mirroring workspaces.deleted_at. Non-null blocks
    // sign-in (AuthService.signIn / signInWithGoogleToken /
    // signInWithLauncherToken all reject it) but the row, its history, and
    // every foreign key referencing it are kept — a superadmin can
    // reactivate the account at any time via the admin portal.
    deactivated_at: timestamp({ withTimezone: true, mode: "string" }),
    // Whether the CoPilot may remember this user across conversations
    // (src/lib/memory/). Owned by the user from Profile → Memory — not an
    // admin toggle, and not per-workspace. On by default; the deployment-wide
    // COPILOT_MEMORY_ENABLED kill-switch sits above it.
    copilot_memory_enabled: boolean().default(true).notNull(),
    // Profile → Your Profile. `name` and `email` above are the ones the rest
    // of the app reads; these are edited on that form and nowhere else.
    nickname: text(),
    phone_code: text(),
    phone: text(),
    job_title: text(),
    /**
     * The user's own words on what they want out of the product. Shown back to
     * them on the profile form; deliberately NOT fed to the CoPilot as an
     * instruction — memory is that channel.
     */
    how_brain_helps: text(),
  },
  (table) => {
    return {
      idxUsersEmail: index("idx_users_email").using(
        "btree",
        table.email.asc().nullsLast().op("text_ops"),
      ),
      idxUsersDeactivatedAt: index("idx_users_deactivated_at").using(
        "btree",
        table.deactivated_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      usersEmailKey: unique("users_email_key").on(table.email),
      allowDeleteAccessOnUsers: pgPolicy("Allow delete access on users", {
        as: "permissive",
        for: "delete",
        to: ["public"],
        using: sql`true`,
      }),
      allowUpdateAccessOnUsers: pgPolicy("Allow update access on users", {
        as: "permissive",
        for: "update",
        to: ["public"],
      }),
      allowInsertAccessOnUsers: pgPolicy("Allow insert access on users", {
        as: "permissive",
        for: "insert",
        to: ["public"],
      }),
      allowReadAccessOnUsers: pgPolicy("Allow read access on users", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

export const userWorkspaces = pgTable(
  "user_workspaces",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    user_id: uuid().notNull(),
    workspace_id: uuid().notNull(),
    role_id: uuid().notNull(),
    // The user's own email is the "custodian mailbox" being watched for this
    // workspace when true (replaces the old workspace_email_to_sync table).
    // Collection only: this decides which mailboxes the pipeline pulls from,
    // NOT what CRM data a workspace member can read. Turning it off stops new
    // email from being ingested and never hides what was already ingested.
    is_email_synced: boolean().default(false).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => {
    return {
      idxUserWorkspacesUserId: index("idx_user_workspaces_user_id").using(
        "btree",
        table.user_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxUserWorkspacesWorkspaceId: index("idx_user_workspaces_workspace_id").using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
      ),
      userWorkspacesUserIdFkey: foreignKey({
        columns: [table.user_id],
        foreignColumns: [users.id],
        name: "user_workspaces_user_id_fkey",
      }).onDelete("cascade"),
      userWorkspacesWorkspaceIdFkey: foreignKey({
        columns: [table.workspace_id],
        foreignColumns: [workspaces.id],
        name: "user_workspaces_workspace_id_fkey",
      }).onDelete("cascade"),
      userWorkspacesRoleIdFkey: foreignKey({
        columns: [table.role_id],
        foreignColumns: [roles.id],
        name: "user_workspaces_role_id_fkey",
      }),
      userWorkspacesUserIdWorkspaceIdKey: unique(
        "user_workspaces_user_id_workspace_id_key",
      ).on(table.user_id, table.workspace_id),
    };
  },
);

export const companyAssignees = pgTable(
  "company_assignees",
  {
    company_id: uuid().notNull(),
    user_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxCompanyAssigneesCompanyId: index(
        "idx_company_assignees_company_id",
      ).using("btree", table.company_id.asc().nullsLast().op("uuid_ops")),
      idxCompanyAssigneesUserId: index("idx_company_assignees_user_id").using(
        "btree",
        table.user_id.asc().nullsLast().op("uuid_ops"),
      ),
      companyAssigneesCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "company_assignees_company_id_fkey",
      }).onDelete("cascade"),
      companyAssigneesUserIdFkey: foreignKey({
        columns: [table.user_id],
        foreignColumns: [users.id],
        name: "company_assignees_user_id_fkey",
      }).onDelete("cascade"),
      companyAssigneesPkey: primaryKey({
        columns: [table.company_id, table.user_id],
        name: "company_assignees_pkey",
      }),
    };
  },
);

export const companyLogs = pgTable(
  "company_logs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    company_id: uuid(),
    action: text().notNull(),
    user_id: uuid(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    entry_id: integer(),
    watchlist_id: integer(),
    segment: text(),
    target: text(),
    segment_related_offerings: text(),
    company_focus: text(),
    website: text(),
    watchlist_status: text(),
    comments: text(),
    ownership: text(),
    geography: text(),
    revenue_2021_usd_mn: numeric({ mode: "number" }),
    revenue_2022_usd_mn: numeric({ mode: "number" }),
    revenue_2023_usd_mn: numeric({ mode: "number" }),
    revenue_2024_usd_mn: numeric({ mode: "number" }),
    ebitda_2021_usd_mn: numeric({ mode: "number" }),
    ebitda_2022_usd_mn: numeric({ mode: "number" }),
    ebitda_2023_usd_mn: numeric({ mode: "number" }),
    ebitda_2024_usd_mn: numeric({ mode: "number" }),
    ev_2024: numeric({ mode: "number" }),
    revenue_cagr_2021_2022: numeric({ mode: "number" }),
    revenue_cagr_2022_2023: numeric({ mode: "number" }),
    revenue_cagr_2023_2024: numeric({ mode: "number" }),
    ebitda_margin_2021: numeric({ mode: "number" }),
    ebitda_margin_2022: numeric({ mode: "number" }),
    ebitda_margin_2023: numeric({ mode: "number" }),
    ebitda_margin_2024: numeric({ mode: "number" }),
    ev_ebitda_2024: numeric({ mode: "number" }),
    segment_revenue: numeric({ mode: "number" }),
    segment_ebitda: numeric({ mode: "number" }),
    segment_revenue_total_ratio: numeric({ mode: "number" }),
    l0_ebitda_2024_usd_mn: numeric({ mode: "number" }),
    l0_ev_2024_usd_mn: numeric({ mode: "number" }),
    l0_revenue_2024_usd_mn: numeric({ mode: "number" }),
    l0_ev_ebitda_2024: numeric({ mode: "number" }),
    segment_specific_revenue_pct: numeric({ mode: "number" }),
    combined_segment_revenue: text(),
    revenue_from_priority_geo_flag: text(),
    pct_from_domestic: numeric({ mode: "number" }),
    l0_ev_usd_mn: numeric({ mode: "number" }),
    l1_revenue_cagr_l3y: numeric({ mode: "number" }),
    l1_revenue_drop_count: integer(),
    l1_ebitda_below_threshold_count: integer(),
    l1_revenue_cagr_n3y: numeric({ mode: "number" }),
    l1_vision_fit: text(),
    l1_priority_geo_flag: text(),
    l1_ev_below_threshold: text(),
    l1_rationale: text(),
    l1_revenue_no_consecutive_drop_usd: text(),
    fx_revenue_2021: numeric({ mode: "number" }),
    fx_revenue_2022: numeric({ mode: "number" }),
    fx_revenue_2023: numeric({ mode: "number" }),
    fx_revenue_2024: numeric({ mode: "number" }),
    fx_currency: text(),
    fx_assumed_forex_2021: numeric({ mode: "number" }),
    fx_assumed_forex_2022: numeric({ mode: "number" }),
    fx_assumed_forex_2023: numeric({ mode: "number" }),
    fx_assumed_forex_2024: numeric({ mode: "number" }),
    fx_forex_change_2021_2022: numeric({ mode: "number" }),
    fx_forex_change_2022_2023: numeric({ mode: "number" }),
    fx_forex_change_2023_2024: numeric({ mode: "number" }),
    fx_revenue_cagr_domestic_2021_2022: numeric({ mode: "number" }),
    fx_revenue_cagr_domestic_2022_2023: numeric({ mode: "number" }),
    fx_revenue_cagr_domestic_2023_2024: numeric({ mode: "number" }),
    fx_revenue_drop_count: integer(),
    fx_revenue_no_consecutive_drop_local: text(),
    fx_rationale: text(),
    fx_ebitda_above_10_l3y: text(),
    l1_screening_result: text(),
  },
  (table) => {
    return {
      idxCompanyLogsCompanyId: index("idx_company_logs_company_id").using(
        "btree",
        table.company_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxCompanyLogsCreatedAt: index("idx_company_logs_created_at").using(
        "btree",
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxCompanyLogsEntryId: index("idx_company_logs_entry_id").using(
        "btree",
        table.entry_id.asc().nullsLast().op("int4_ops"),
      ),
      idxCompanyLogsSegment: index("idx_company_logs_segment").using(
        "btree",
        table.segment.asc().nullsLast().op("text_ops"),
      ),
      idxCompanyLogsUserId: index("idx_company_logs_user_id").using(
        "btree",
        table.user_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxCompanyLogsWatchlistStatus: index(
        "idx_company_logs_watchlist_status",
      ).using("btree", table.watchlist_status.asc().nullsLast().op("text_ops")),
      companyLogsUserIdFkey: foreignKey({
        columns: [table.user_id],
        foreignColumns: [users.id],
        name: "company_logs_user_id_fkey",
      }).onDelete("set null"),
      companyLogsCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "company_logs_company_id_fkey",
      }).onDelete("cascade"),
      allowDeleteAccessOnCompanyLogs: pgPolicy(
        "Allow delete access on company_logs",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnCompanyLogs: pgPolicy(
        "Allow update access on company_logs",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnCompanyLogs: pgPolicy(
        "Allow insert access on company_logs",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnCompanyLogs: pgPolicy(
        "Allow read access on company_logs",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

export const investmentThesis = pgTable(
  "investment_thesis",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: text().notNull(),
    content: text().notNull(),
    // Person in charge of this thesis ("Track"). Free-text (team member name).
    pic: text(),
    is_active: boolean().default(true),
    scan_frequency: text().default("weekly"),
    last_scan_at: timestamp({ withTimezone: true, mode: "string" }),
    next_scan_at: timestamp({ withTimezone: true, mode: "string" }),
    sources_count: integer().default(5),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => {
    return {
      idxInvestmentThesisWorkspaceId: index(
        "idx_investment_thesis_workspace_id",
      ).using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
      idxInvestmentThesisIsActive: index(
        "idx_investment_thesis_is_active",
      ).using("btree", table.is_active.asc().nullsLast().op("bool_ops")),
      idxInvestmentThesisNextScanAt: index(
        "idx_investment_thesis_next_scan_at",
      ).using(
        "btree",
        table.next_scan_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      allowDeleteAccessOnInvestmentThesis: pgPolicy(
        "Allow delete access on investment_thesis",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnInvestmentThesis: pgPolicy(
        "Allow update access on investment_thesis",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnInvestmentThesis: pgPolicy(
        "Allow insert access on investment_thesis",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnInvestmentThesis: pgPolicy(
        "Allow read access on investment_thesis",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

export const screenings = pgTable(
  "screenings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    company_id: uuid().notNull(),
    criteria_id: uuid().notNull(),
    // The investment_thesis ("Track") this screening run belongs to. A company
    // matched to N tracks yields N screening groups. NULL on legacy rows.
    track_id: uuid(),
    state: screeningState().default("pending").notNull(),
    result: text(),
    remarks: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    job_id: uuid(),
  },
  (table) => {
    return {
      idxScreeningsCompanyId: index("idx_screenings_company_id").using(
        "btree",
        table.company_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxScreeningsCreatedAt: index("idx_screenings_created_at").using(
        "btree",
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxScreeningsCriteriaId: index("idx_screenings_criteria_id").using(
        "btree",
        table.criteria_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxScreeningsJobId: index("idx_screenings_job_id").using(
        "btree",
        table.job_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxScreeningsTrackId: index("idx_screenings_track_id").using(
        "btree",
        table.track_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxScreeningsState: index("idx_screenings_state").using(
        "btree",
        table.state.asc().nullsLast().op("enum_ops"),
      ),
      screeningsCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "screenings_company_id_fkey",
      }).onDelete("cascade"),
      screeningsCriteriaIdFkey: foreignKey({
        columns: [table.criteria_id],
        foreignColumns: [criterias.id],
        name: "screenings_criteria_id_fkey",
      }).onDelete("cascade"),
      screeningsJobIdFkey: foreignKey({
        columns: [table.job_id],
        foreignColumns: [jobs.id],
        name: "screenings_job_id_fkey",
      }).onDelete("set null"),
      screeningsTrackIdFkey: foreignKey({
        columns: [table.track_id],
        foreignColumns: [investmentThesis.id],
        name: "screenings_track_id_fkey",
      }).onDelete("cascade"),
      screeningsCompanyTrackCriteriaKey: unique(
        "screenings_company_track_criteria_key",
      ).on(table.company_id, table.track_id, table.criteria_id),
      allowDeleteAccessOnScreenings: pgPolicy(
        "Allow delete access on screenings",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnScreenings: pgPolicy(
        "Allow update access on screenings",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnScreenings: pgPolicy(
        "Allow insert access on screenings",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnScreenings: pgPolicy("Allow read access on screenings", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

export const dealNotes = pgTable(
  "deal_notes",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid().notNull(),
    content: text().notNull(),
    stage: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxDealNotesCreatedAt: index("idx_deal_notes_created_at").using(
        "btree",
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxDealNotesDealId: index("idx_deal_notes_deal_id").using(
        "btree",
        table.deal_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxDealNotesStage: index("idx_deal_notes_stage").using(
        "btree",
        table.stage.asc().nullsLast().op("text_ops"),
      ),
      dealNotesDealIdFkey: foreignKey({
        columns: [table.deal_id],
        foreignColumns: [companies.id],
        name: "deal_notes_deal_id_fkey",
      }).onDelete("cascade"),
      allowDeleteAccessOnDealNotes: pgPolicy(
        "Allow delete access on deal_notes",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnDealNotes: pgPolicy(
        "Allow update access on deal_notes",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnDealNotes: pgPolicy(
        "Allow insert access on deal_notes",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnDealNotes: pgPolicy("Allow read access on deal_notes", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

export const dealLinks = pgTable(
  "deal_links",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid().notNull(),
    url: text().notNull(),
    title: text(),
    stage: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxDealLinksDealId: index("idx_deal_links_deal_id").using(
        "btree",
        table.deal_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxDealLinksStage: index("idx_deal_links_stage").using(
        "btree",
        table.stage.asc().nullsLast().op("text_ops"),
      ),
      dealLinksDealIdFkey: foreignKey({
        columns: [table.deal_id],
        foreignColumns: [companies.id],
        name: "deal_links_deal_id_fkey",
      }).onDelete("cascade"),
      allowDeleteAccessOnDealLinks: pgPolicy(
        "Allow delete access on deal_links",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnDealLinks: pgPolicy(
        "Allow update access on deal_links",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnDealLinks: pgPolicy(
        "Allow insert access on deal_links",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnDealLinks: pgPolicy("Allow read access on deal_links", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

export const dealDocuments = pgTable(
  "deal_documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid().notNull(),
    file_name: text().notNull(),
    file_path: text().notNull(),
    file_size: integer(),
    mime_type: text(),
    stage: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    raw_notes: text(),
    structured_notes: text(),
    tags: text().array().default([]),
    processing_status: text().default("pending"),
    is_featured: boolean().default(false).notNull(),
  },
  (table) => {
    return {
      idxDealDocumentsDealId: index("idx_deal_documents_deal_id").using(
        "btree",
        table.deal_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxDealDocumentsStage: index("idx_deal_documents_stage").using(
        "btree",
        table.stage.asc().nullsLast().op("text_ops"),
      ),
      // At most one featured slide per deal — uploading a new one clears the
      // previous row (see DealDocumentService.register) before insert, but
      // this is the safety net against a race between two uploads.
      uqDealDocumentsOneFeatured: uniqueIndex("uq_deal_documents_one_featured")
        .using("btree", table.deal_id.asc().nullsLast().op("uuid_ops"))
        .where(sql`is_featured = true`),
      dealDocumentsDealIdFkey: foreignKey({
        columns: [table.deal_id],
        foreignColumns: [companies.id],
        name: "deal_documents_deal_id_fkey",
      }).onDelete("cascade"),
      allowDeleteAccessOnDealDocuments: pgPolicy(
        "Allow delete access on deal_documents",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnDealDocuments: pgPolicy(
        "Allow update access on deal_documents",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnDealDocuments: pgPolicy(
        "Allow insert access on deal_documents",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnDealDocuments: pgPolicy(
        "Allow read access on deal_documents",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

export const companyAnalyses = pgTable(
  "company_analyses",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    company_id: uuid().notNull(),
    status: analysisJobStatus().default("pending").notNull(),
    business_overview: text(),
    business_model_summary: text(),
    key_takeaways: text(),
    investment_highlights: text(),
    investment_risks: text(),
    diligence_priorities: text(),
    sources: jsonb().$type<unknown>(),
    error_message: text(),
    logo_url: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    job_id: uuid(),
  },
  (table) => {
    return {
      idxCompanyAnalysesCompanyId: index(
        "idx_company_analyses_company_id",
      ).using("btree", table.company_id.asc().nullsLast().op("uuid_ops")),
      idxCompanyAnalysesCreatedAt: index(
        "idx_company_analyses_created_at",
      ).using(
        "btree",
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxCompanyAnalysesJobId: index("idx_company_analyses_job_id").using(
        "btree",
        table.job_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxCompanyAnalysesStatus: index("idx_company_analyses_status").using(
        "btree",
        table.status.asc().nullsLast().op("text_ops"),
      ),
      companyAnalysesCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "company_analyses_company_id_fkey",
      }).onDelete("cascade"),
      companyAnalysesJobIdFkey: foreignKey({
        columns: [table.job_id],
        foreignColumns: [jobs.id],
        name: "company_analyses_job_id_fkey",
      }).onDelete("set null"),
      companyAnalysesCompanyIdKey: unique("company_analyses_company_id_key").on(
        table.company_id,
      ),
      allowDeleteAccessOnCompanyAnalyses: pgPolicy(
        "Allow delete access on company_analyses",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnCompanyAnalyses: pgPolicy(
        "Allow update access on company_analyses",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnCompanyAnalyses: pgPolicy(
        "Allow insert access on company_analyses",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnCompanyAnalyses: pgPolicy(
        "Allow read access on company_analyses",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

export const companySlides = pgTable(
  "company_slides",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    company_id: uuid().notNull(),
    title: text().default("Untitled").notNull(),
    html: text().default("").notNull(),
    sort_order: integer().default(0).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    job_id: uuid(),
  },
  (table) => {
    return {
      idxCompanySlidesCompanyId: index("idx_company_slides_company_id").using(
        "btree",
        table.company_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxCompanySlidesJobId: index("idx_company_slides_job_id").using(
        "btree",
        table.job_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxCompanySlidesSortOrder: index("idx_company_slides_sort_order").using(
        "btree",
        table.company_id.asc().nullsLast().op("uuid_ops"),
        table.sort_order.asc().nullsLast().op("uuid_ops"),
      ),
      companySlidesCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "company_slides_company_id_fkey",
      }).onDelete("cascade"),
      companySlidesJobIdFkey: foreignKey({
        columns: [table.job_id],
        foreignColumns: [jobs.id],
        name: "company_slides_job_id_fkey",
      }).onDelete("set null"),
      allowDeleteAccessOnCompanySlides: pgPolicy(
        "Allow delete access on company_slides",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnCompanySlides: pgPolicy(
        "Allow update access on company_slides",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnCompanySlides: pgPolicy(
        "Allow insert access on company_slides",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnCompanySlides: pgPolicy(
        "Allow read access on company_slides",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

export const invenCache = pgTable(
  "inven_cache",
  {
    inven_company_id: text().primaryKey().notNull(),
    domain: text(),
    inven_company_name: text(),
    website: text(),
    linkedin: text(),
    description: text(),
    logo_url: text(),
    headcount_min: integer(),
    headcount_max: integer(),
    employee_count: integer(),
    revenue_estimate_usd_millions: numeric({ mode: "number" }),
    ownership: text(),
    founded_year: integer(),
    headquarters_city: text(),
    headquarters_state: text(),
    headquarters_country_code: text(),
    id: uuid().defaultRandom(),
    entry_id: integer(),
    watchlist_id: integer(),
    target: text(),
    segment: text(),
    segment_related_offerings: text(),
    company_focus: text(),
    watchlist_status: text(),
    pipeline_stage: text(),
    comments: text(),
    geography: text(),
    revenue_2021_usd_mn: numeric({ mode: "number" }),
    revenue_2022_usd_mn: numeric({ mode: "number" }),
    revenue_2023_usd_mn: numeric({ mode: "number" }),
    revenue_2024_usd_mn: numeric({ mode: "number" }),
    ebitda_2021_usd_mn: numeric({ mode: "number" }),
    ebitda_2022_usd_mn: numeric({ mode: "number" }),
    ebitda_2023_usd_mn: numeric({ mode: "number" }),
    ebitda_2024_usd_mn: numeric({ mode: "number" }),
    ev_2024: numeric({ mode: "number" }),
    revenue_cagr_2021_2022: numeric({ mode: "number" }),
    revenue_cagr_2022_2023: numeric({ mode: "number" }),
    revenue_cagr_2023_2024: numeric({ mode: "number" }),
    ebitda_margin_2021: numeric({ mode: "number" }),
    ebitda_margin_2022: numeric({ mode: "number" }),
    ebitda_margin_2023: numeric({ mode: "number" }),
    ebitda_margin_2024: numeric({ mode: "number" }),
    ev_ebitda_2024: numeric({ mode: "number" }),
    segment_revenue: numeric({ mode: "number" }),
    segment_ebitda: numeric({ mode: "number" }),
    segment_revenue_total_ratio: numeric({ mode: "number" }),
    l0_ebitda_2024_usd_mn: numeric({ mode: "number" }),
    l0_ev_2024_usd_mn: numeric({ mode: "number" }),
    l0_revenue_2024_usd_mn: numeric({ mode: "number" }),
    l0_ev_ebitda_2024: numeric({ mode: "number" }),
    segment_specific_revenue_pct: numeric({ mode: "number" }),
    combined_segment_revenue: text(),
    revenue_from_priority_geo_flag: text(),
    pct_from_domestic: numeric({ mode: "number" }),
    l0_ev_usd_mn: numeric({ mode: "number" }),
    l1_revenue_cagr_l3y: numeric({ mode: "number" }),
    l1_revenue_drop_count: integer(),
    l1_ebitda_below_threshold_count: integer(),
    l1_revenue_cagr_n3y: numeric({ mode: "number" }),
    l1_vision_fit: text(),
    l1_priority_geo_flag: text(),
    l1_ev_below_threshold: text(),
    l1_rationale: text(),
    l1_revenue_no_consecutive_drop_usd: text(),
    fx_revenue_2021: numeric({ mode: "number" }),
    fx_revenue_2022: numeric({ mode: "number" }),
    fx_revenue_2023: numeric({ mode: "number" }),
    fx_revenue_2024: numeric({ mode: "number" }),
    fx_currency: text(),
    fx_assumed_forex_2021: numeric({ mode: "number" }),
    fx_assumed_forex_2022: numeric({ mode: "number" }),
    fx_assumed_forex_2023: numeric({ mode: "number" }),
    fx_assumed_forex_2024: numeric({ mode: "number" }),
    fx_forex_change_2021_2022: numeric({ mode: "number" }),
    fx_forex_change_2022_2023: numeric({ mode: "number" }),
    fx_forex_change_2023_2024: numeric({ mode: "number" }),
    fx_revenue_cagr_domestic_2021_2022: numeric({ mode: "number" }),
    fx_revenue_cagr_domestic_2022_2023: numeric({ mode: "number" }),
    fx_revenue_cagr_domestic_2023_2024: numeric({ mode: "number" }),
    fx_revenue_drop_count: integer(),
    fx_revenue_no_consecutive_drop_local: text(),
    fx_rationale: text(),
    fx_ebitda_above_10_l3y: text(),
    l1_screening_result: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxInvenCacheDomain: index("idx_inven_cache_domain").using(
        "btree",
        table.domain.asc().nullsLast().op("text_ops"),
      ),
      idxInvenCacheGeography: index("idx_inven_cache_geography").using(
        "btree",
        table.geography.asc().nullsLast().op("text_ops"),
      ),
      idxInvenCacheInvenCompanyName: index(
        "idx_inven_cache_inven_company_name",
      ).using(
        "btree",
        table.inven_company_name.asc().nullsLast().op("text_ops"),
      ),
      idxInvenCacheSegment: index("idx_inven_cache_segment").using(
        "btree",
        table.segment.asc().nullsLast().op("text_ops"),
      ),
      idxInvenCacheTarget: index("idx_inven_cache_target").using(
        "btree",
        table.target.asc().nullsLast().op("text_ops"),
      ),
      allowDeleteAccessOnInvenCache: pgPolicy(
        "Allow delete access on inven_cache",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnInvenCache: pgPolicy(
        "Allow update access on inven_cache",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnInvenCache: pgPolicy(
        "Allow insert access on inven_cache",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnInvenCache: pgPolicy(
        "Allow read access on inven_cache",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

export const resetPasswordTokens = pgTable(
  "reset_password_tokens",
  {
    token: text().primaryKey().notNull(),
    user_id: uuid().notNull(),
    valid_until: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxResetPasswordTokensUserId: index(
        "idx_reset_password_tokens_user_id",
      ).using("btree", table.user_id.asc().nullsLast().op("uuid_ops")),
      resetPasswordTokensUserIdFkey: foreignKey({
        columns: [table.user_id],
        foreignColumns: [users.id],
        name: "reset_password_tokens_user_id_fkey",
      }).onDelete("cascade"),
    };
  },
);

export const files = pgTable(
  "files",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    file_name: text().notNull(),
    file_link: text().notNull(),
    raw_notes: text(),
    structured_notes: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    tags: text().array().default([]),
    processing_status: text().default("pending"),
    // Runtime chips include AI suggestions (null id + name) and pipeline
    // links (id + name/target/type/similarity). Keep this in sync with
    // MatchedCompaniesCell.MatchedCompanyChip and FileService writes.
    matched_companies: jsonb()
      .$type<
        {
          id?: string | null;
          name?: string;
          target?: string;
          type?: string;
          similarity?: number;
        }[]
      >()
      .default([]),
    file_date: date(),
    file_type: varchar().default("mom").notNull(),
    origin_email: boolean().default(false).notNull(),
    drop_reason: text(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => {
    return {
      idxFilesWorkspaceId: index("idx_files_workspace_id").using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxFilesCreatedAt: index("idx_files_created_at").using(
        "btree",
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      // Supports the `matched_companies @> '[{"id": ...}]'` containment filter
      // used by the company-detail read and Company Card generation.
      // jsonb_path_ops keeps the index small since we only ever use `@>`.
      idxFilesMatchedCompaniesGin: index("idx_files_matched_companies_gin").using(
        "gin",
        table.matched_companies.asc().nullsLast().op("jsonb_path_ops"),
      ),
      idxFilesFileName: index("idx_files_file_name").using(
        "btree",
        table.file_name.asc().nullsLast().op("text_ops"),
      ),
      idxMinutesOfMeetingFileDate: index(
        "idx_minutes_of_meeting_file_date",
      ).using("btree", table.file_date.asc().nullsLast().op("date_ops")),
      idxMinutesOfMeetingProcessingStatus: index(
        "idx_minutes_of_meeting_processing_status",
      ).using(
        "btree",
        table.processing_status.asc().nullsLast().op("text_ops"),
      ),
      idxMinutesOfMeetingTags: index("idx_minutes_of_meeting_tags").using(
        "gin",
        table.tags.asc().nullsLast().op("array_ops"),
      ),
      allowDeleteAccessOnFiles: pgPolicy("Allow delete access on files", {
        as: "permissive",
        for: "delete",
        to: ["public"],
        using: sql`true`,
      }),
      allowUpdateAccessOnFiles: pgPolicy("Allow update access on files", {
        as: "permissive",
        for: "update",
        to: ["public"],
      }),
      allowInsertAccessOnFiles: pgPolicy("Allow insert access on files", {
        as: "permissive",
        for: "insert",
        to: ["public"],
      }),
      allowReadAccessOnFiles: pgPolicy("Allow read access on files", {
        as: "permissive",
        for: "select",
        to: ["public"],
      }),
    };
  },
);

export const companyFinancials = pgTable(
  "company_financials",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    company_id: uuid().notNull(),
    fiscal_year: integer().notNull(),
    revenue_usd_mn: numeric({ mode: "number" }),
    ebitda_usd_mn: numeric({ mode: "number" }),
    ev_usd_mn: numeric({ mode: "number" }),
    ebitda_margin: numeric({ mode: "number" }),
    ev_ebitda: numeric({ mode: "number" }),
    revenue_cagr_vs_prior: numeric({ mode: "number" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxCompanyFinancialsCompanyId: index(
        "idx_company_financials_company_id",
      ).using("btree", table.company_id.asc().nullsLast().op("uuid_ops")),
      companyFinancialsCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "company_financials_company_id_fkey",
      }).onDelete("cascade"),
      companyFinancialsCompanyYearUniq: unique(
        "company_financials_company_year_uniq",
      ).on(table.company_id, table.fiscal_year),
      companyFinancialsYearChk: check(
        "company_financials_year_chk",
        sql`(fiscal_year >= 1990) AND (fiscal_year <= 2100)`,
      ),
    };
  },
);

export const companyFxAdjustments = pgTable(
  "company_fx_adjustments",
  {
    company_id: uuid().notNull(),
    fiscal_year: integer().notNull(),
    currency: text().notNull(),
    revenue_local: numeric({ mode: "number" }),
    ebitda_local: numeric({ mode: "number" }),
    assumed_forex: numeric({ mode: "number" }),
    forex_change_vs_prior: numeric({ mode: "number" }),
    revenue_cagr_domestic: numeric({ mode: "number" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      companyFxAdjustmentsCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "company_fx_adjustments_company_id_fkey",
      }).onDelete("cascade"),
      companyFxAdjustmentsPkey: primaryKey({
        columns: [table.company_id, table.fiscal_year],
        name: "company_fx_adjustments_pkey",
      }),
      companyFxAdjustmentsYearChk: check(
        "company_fx_adjustments_year_chk",
        sql`(fiscal_year >= 1990) AND (fiscal_year <= 2100)`,
      ),
    };
  },
);

export const companyScreeningDerived = pgTable(
  "company_screening_derived",
  {
    company_id: uuid().primaryKey().notNull(),
    segment_revenue: numeric({ mode: "number" }),
    segment_ebitda: numeric({ mode: "number" }),
    segment_revenue_total_ratio: numeric({ mode: "number" }),
    l0_ebitda_2024_usd_mn: numeric({ mode: "number" }),
    l0_ev_2024_usd_mn: numeric({ mode: "number" }),
    l0_revenue_2024_usd_mn: numeric({ mode: "number" }),
    l0_ev_ebitda_2024: numeric({ mode: "number" }),
    segment_specific_revenue_pct: numeric({ mode: "number" }),
    combined_segment_revenue: text(),
    pct_from_domestic: numeric({ mode: "number" }),
    l0_ev_usd_mn: numeric({ mode: "number" }),
    revenue_from_priority_geo: boolean(),
    l1_revenue_cagr_l3y: numeric({ mode: "number" }),
    l1_revenue_drop_count: integer(),
    l1_ebitda_below_threshold_count: integer(),
    l1_revenue_cagr_n3y: numeric({ mode: "number" }),
    l1_vision_fit: boolean(),
    l1_priority_geo: boolean(),
    l1_ev_below_threshold: boolean(),
    l1_revenue_no_consecutive_drop: boolean(),
    l1_rationale: text(),
    l1_screening_result: l1Result(),
    fx_currency: text(),
    fx_revenue_drop_count: integer(),
    fx_revenue_no_consecutive_drop: boolean(),
    fx_ebitda_above_10_l3y: boolean(),
    fx_rationale: text(),
    computed_at: timestamp({ withTimezone: true, mode: "string" }),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxCompanyScreeningDerivedL1Result: index(
        "idx_company_screening_derived_l1_result",
      ).using(
        "btree",
        table.l1_screening_result.asc().nullsLast().op("enum_ops"),
      ),
      companyScreeningDerivedCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "company_screening_derived_company_id_fkey",
      }).onDelete("cascade"),
    };
  },
);

// MB-260: per-user history of files opened in the Presentation page. One row
// per (user, file_key); re-opening a file bumps opened_at via upsert so the
// list stays a deduped, most-recent-first feed.
export const recentFiles = pgTable(
  "recent_files",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    user_id: uuid().notNull(),
    file_name: text().notNull(),
    file_key: text().notNull(),
    opened_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => {
    return {
      idxRecentFilesWorkspaceId: index(
        "idx_recent_files_workspace_id",
      ).using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
      idxRecentFilesUserOpened: index("idx_recent_files_user_opened").using(
        "btree",
        table.user_id.asc().nullsLast().op("uuid_ops"),
        table.opened_at.desc().nullsLast().op("timestamptz_ops"),
      ),
      recentFilesUserIdFkey: foreignKey({
        columns: [table.user_id],
        foreignColumns: [users.id],
        name: "recent_files_user_id_fkey",
      }).onDelete("cascade"),
      recentFilesUserIdFileKeyKey: unique("recent_files_user_id_file_key_key").on(
        table.user_id,
        table.file_key,
      ),
    };
  },
);

// ============================================================================
// CRM v2 — employers, correspondents, topics, emails. Replaces the legacy
// `contacts` / `contact_messages` model.
// ============================================================================

export const emailParticipantRole = pgEnum("email_participant_role", [
  "from",
  "to",
  "cc",
  "bcc",
]);

export const employers = pgTable(
  "employers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    normalized_name: text().notNull(),
    industry: text(),
    status: text().default("inbound").notNull(),
    curation_status: text().default("published").notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    employersNormalizedNameKey: unique("employers_normalized_name_key").on(
      table.normalized_name,
    ),
    idxEmployersName: index("idx_employers_name").using(
      "btree",
      table.name.asc().nullsLast().op("text_ops"),
    ),
    idxEmployersStatus: index("idx_employers_status").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    idxEmployersCuration: index("idx_employers_curation").using(
      "btree",
      table.curation_status.asc().nullsLast().op("text_ops"),
    ),
    allowReadEmployers: pgPolicy("Allow read access on employers", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertEmployers: pgPolicy("Allow insert access on employers", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    allowUpdateEmployers: pgPolicy("Allow update access on employers", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    allowDeleteEmployers: pgPolicy("Allow delete access on employers", {
      as: "permissive",
      for: "delete",
      to: ["public"],
      using: sql`true`,
    }),
  }),
);

export const correspondents = pgTable(
  "correspondents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    employer_id: uuid().notNull(),
    name: text().notNull(),
    title: text(),
    email: text(),
    phone: text(),
    type: text(),
    // Banker profile fields (20261006000000_add_correspondent_profile_fields).
    // Base side of the RFC §3.4 overlay pair: written when a human CREATES a
    // contact (origin='manual'), while EDITING an existing one writes the
    // `correspondent_curation` twins instead. The ingest upsert never touches
    // these columns. `correspondent_effective` COALESCEs overlay over base.
    department: text(),
    specialization: text(),
    seniority: text(),
    coverage_region: text(),
    linkedin_url: text(),
    bio: text(),
    is_primary: boolean().default(false).notNull(),
    source: text().default("manual").notNull(),
    // MB-205: 'auto' = machine-discovered from MBOX (ETL may update/prune);
    // 'manual' = human-added (ETL never touches). See RFC §3.4.
    origin: text().default("auto").notNull(),
    last_edited_by_user_id: uuid(),
    last_edited_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    idxCorrespondentEmail: index("idx_correspondent_email").using(
      "btree",
      table.email.asc().nullsLast().op("text_ops"),
    ),
    correspondentsEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "correspondents_employer_id_fkey",
    }).onDelete("cascade"),
    correspondentsLastEditedFkey: foreignKey({
      columns: [table.last_edited_by_user_id],
      foreignColumns: [users.id],
      name: "correspondents_last_edited_by_user_id_fkey",
    }).onDelete("set null"),
    allowReadCorrespondents: pgPolicy("Allow read access on correspondents", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertCorrespondents: pgPolicy(
      "Allow insert access on correspondents",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateCorrespondents: pgPolicy(
      "Allow update access on correspondents",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteCorrespondents: pgPolicy(
      "Allow delete access on correspondents",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

// Correspondent visibility membership — see 20260705000000_add_workspace_correspondents.sql.
// employers/correspondents stay shared, global identity; this add-only
// junction is what makes a workspace only see the contacts sourced from its
// own custodian mailboxes (crmIngest) or manually added by it (createContact).
export const workspaceCorrespondents = pgTable(
  "workspace_correspondents",
  {
    workspace_id: uuid().notNull(),
    correspondent_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    // Provenance — 'ingest' (crmIngest fan-out) or 'manual' (createContact/
    // curateEmployer). Prerequisite for a future revoke-on-unsync sweep: a
    // manually-added contact must never be revoked just because an unrelated
    // mailbox in the workspace got un-synced. See
    // 20260705000005_workspace_correspondents_source.sql.
    source: text().notNull().default("ingest"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspace_id, table.correspondent_id] }),
    idxWorkspaceCorrespondentsCorrespondentId: index(
      "idx_workspace_correspondents_correspondent_id",
    ).using("btree", table.correspondent_id.asc().nullsLast().op("uuid_ops")),
    workspaceCorrespondentsWorkspaceFkey: foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
      name: "workspace_correspondents_workspace_id_fkey",
    }).onDelete("cascade"),
    workspaceCorrespondentsCorrespondentFkey: foreignKey({
      columns: [table.correspondent_id],
      foreignColumns: [correspondents.id],
      name: "workspace_correspondents_correspondent_id_fkey",
    }).onDelete("cascade"),
    workspaceCorrespondentsSourceChk: check(
      "chk_workspace_correspondents_source",
      sql`source IN ('ingest', 'manual')`,
    ),
  }),
);


export const employerNotes = pgTable(
  "employer_notes",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    employer_id: uuid().notNull(),
    workspace_id: uuid().notNull(),
    author_user_id: uuid(),
    content: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    idxNotesEmployerCreated: index("idx_notes_employer_created").using(
      "btree",
      table.employer_id.asc().nullsLast().op("uuid_ops"),
      table.created_at.asc().nullsLast().op("timestamptz_ops"),
    ),
    idxEmployerNotesWorkspaceId: index("idx_employer_notes_workspace_id").using(
      "btree",
      table.workspace_id.asc().nullsLast().op("uuid_ops"),
    ),
    employerNotesEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "employer_notes_employer_id_fkey",
    }).onDelete("cascade"),
    employerNotesWorkspaceFkey: foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
      name: "employer_notes_workspace_id_fkey",
    }).onDelete("cascade"),
    employerNotesAuthorFkey: foreignKey({
      columns: [table.author_user_id],
      foreignColumns: [users.id],
      name: "employer_notes_author_user_id_fkey",
    }).onDelete("set null"),
    allowReadEmployerNotes: pgPolicy("Allow read access on employer_notes", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertEmployerNotes: pgPolicy(
      "Allow insert access on employer_notes",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateEmployerNotes: pgPolicy(
      "Allow update access on employer_notes",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteEmployerNotes: pgPolicy(
      "Allow delete access on employer_notes",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

export const topics = pgTable(
  "topics",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),
    is_deal_related: boolean().default(false).notNull(),
    // NULL = shared classification vocabulary (LLM enrichment taxonomy,
    // untouched by workspace scoping); set = a workspace's own private
    // topic. See 20260705000003_topics_workspace_id.sql.
    workspace_id: uuid(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    topicsNameGlobalKey: uniqueIndex("topics_name_global_key")
      .on(table.name)
      .where(sql`workspace_id IS NULL`),
    topicsNameWorkspaceKey: uniqueIndex("topics_name_workspace_key")
      .on(table.workspace_id, table.name)
      .where(sql`workspace_id IS NOT NULL`),
    topicsSlugGlobalKey: uniqueIndex("topics_slug_global_key")
      .on(table.slug)
      .where(sql`workspace_id IS NULL`),
    topicsSlugWorkspaceKey: uniqueIndex("topics_slug_workspace_key")
      .on(table.workspace_id, table.slug)
      .where(sql`workspace_id IS NOT NULL`),
    topicsWorkspaceFkey: foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
      name: "topics_workspace_id_fkey",
    }).onDelete("cascade"),
    allowReadTopics: pgPolicy("Allow read access on topics", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertTopics: pgPolicy("Allow insert access on topics", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    allowUpdateTopics: pgPolicy("Allow update access on topics", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    allowDeleteTopics: pgPolicy("Allow delete access on topics", {
      as: "permissive",
      for: "delete",
      to: ["public"],
      using: sql`true`,
    }),
  }),
);

export const employerTopics = pgTable(
  "employer_topics",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    employer_id: uuid().notNull(),
    topic_id: uuid().notNull(),
    source: text().default("manual").notNull(),
    is_highlight: boolean().default(false).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uqEmployerTopic: unique("uq_employer_topic").on(
      table.employer_id,
      table.topic_id,
    ),
    employerTopicsEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "employer_topics_employer_id_fkey",
    }).onDelete("cascade"),
    employerTopicsTopicFkey: foreignKey({
      columns: [table.topic_id],
      foreignColumns: [topics.id],
      name: "employer_topics_topic_id_fkey",
    }).onDelete("cascade"),
    allowReadEmployerTopics: pgPolicy("Allow read access on employer_topics", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertEmployerTopics: pgPolicy(
      "Allow insert access on employer_topics",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateEmployerTopics: pgPolicy(
      "Allow update access on employer_topics",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteEmployerTopics: pgPolicy(
      "Allow delete access on employer_topics",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

// ─── MB-208: employer_related_companies (public) ─────────────────────────────
// Aggregate: one row per (banker employer × detected target company).
// Evidence lives in analytics.employerRelatedCompanyEvidence (below).
export const employerRelatedCompanies = pgTable(
  "employer_related_companies",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    employer_id: uuid().notNull(),
    company_id: uuid(),
    // Stamped directly at write time (both the auto/ingest and manual
    // paths), not derived through company_id — company_id is nullable
    // (free-text company name with no match), so it can't reliably supply
    // a workspace. See 20260705000002_employer_related_companies_workspace_id.sql.
    workspace_id: uuid().notNull(),
    company_name: text().notNull(),
    normalized_company_name: text().notNull(),
    source: text().default("auto").notNull(),
    confidence: text().default("medium").notNull(),
    reason: text().notNull(),
    reason_summary: text(),
    evidence_count: integer().default(0).notNull(),
    first_seen_at: timestamp({ withTimezone: true, mode: "string" }),
    last_seen_at: timestamp({ withTimezone: true, mode: "string" }),
    dismissed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uqErcWorkspaceEmployerCompanySource: unique(
      "uq_erc_workspace_employer_company_source",
    ).on(
      table.workspace_id,
      table.employer_id,
      table.normalized_company_name,
      table.source,
    ),
    idxErcEmployerId: index("idx_erc_employer_id").using(
      "btree",
      table.employer_id.asc().nullsLast().op("uuid_ops"),
    ),
    idxErcCompanyId: index("idx_erc_company_id").using(
      "btree",
      table.company_id.asc().nullsLast().op("uuid_ops"),
    ),
    idxErcWorkspaceId: index("idx_erc_workspace_id").using(
      "btree",
      table.workspace_id.asc().nullsLast().op("uuid_ops"),
    ),
    ercEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "employer_related_companies_employer_id_fkey",
    }).onDelete("cascade"),
    ercCompanyFkey: foreignKey({
      columns: [table.company_id],
      foreignColumns: [companies.id],
      name: "employer_related_companies_company_id_fkey",
    }).onDelete("set null"),
    ercWorkspaceFkey: foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
      name: "employer_related_companies_workspace_id_fkey",
    }).onDelete("cascade"),
    allowReadErc: pgPolicy("Allow read access on employer_related_companies", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertErc: pgPolicy(
      "Allow insert access on employer_related_companies",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateErc: pgPolicy(
      "Allow update access on employer_related_companies",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteErc: pgPolicy(
      "Allow delete access on employer_related_companies",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

// Evidence table for explainability. Lives in analytics because it FKs to
// analytics.emails — analytics→public is allowed. raw_email_id removed in
// ephemeral Phase 0 (rekeyed to email_id only).
export const employerRelatedCompanyEvidence = analytics.table(
  "employer_related_company_evidence",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    related_company_id: uuid().notNull(),
    email_id: uuid(),
    // Retained nullable for schema compat; writers must leave null (no body quotes).
    matched_text: text(),
    reason: text().notNull(),
    reason_summary: text(),
    keywords: jsonb().$type<string[]>(),
    confidence: text().default("medium").notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uqErce: unique("uq_erce_company_email").on(
      table.related_company_id,
      table.email_id,
    ),
    idxErceRelatedCompanyId: index("idx_erce_related_company_id").using(
      "btree",
      table.related_company_id.asc().nullsLast().op("uuid_ops"),
    ),
    idxErceEmailId: index("idx_erce_email_id").using(
      "btree",
      table.email_id.asc().nullsLast().op("uuid_ops"),
    ),
    erceRelatedCompanyFkey: foreignKey({
      columns: [table.related_company_id],
      foreignColumns: [employerRelatedCompanies.id],
      name: "erce_related_company_id_fkey",
    }).onDelete("cascade"),
    erceEmailFkey: foreignKey({
      columns: [table.email_id],
      foreignColumns: [emails.id],
      name: "erce_email_id_fkey",
    }).onDelete("cascade"),
  }),
);

// ============================================================================
// MB-205 — Overlay + identity tables. These stay in `public` (editable system
// of record); the `analytics` schema (declared at top) holds the data plane.
// ============================================================================

// Durable, curatable domain → employer map. UNIQUE(domain) guarantees one
// domain resolves to exactly one employer; supports one-employer-many-domains.
// Makes email-sourced identity reprocess-stable (resolve once, reuse). RFC §6.
export const employerDomains = pgTable(
  "employer_domains",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    employer_id: uuid().notNull(),
    domain: text().notNull(),
    source: text().default("auto").notNull(), // 'auto' | 'manual'
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    employerDomainsDomainKey: unique("employer_domains_domain_key").on(
      table.domain,
    ),
    employerDomainsEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "employer_domains_employer_id_fkey",
    }).onDelete("cascade"),
    allowReadEmployerDomains: pgPolicy("Allow read access on employer_domains", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertEmployerDomains: pgPolicy(
      "Allow insert access on employer_domains",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateEmployerDomains: pgPolicy(
      "Allow update access on employer_domains",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteEmployerDomains: pgPolicy(
      "Allow delete access on employer_domains",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

// Curator-editable domain → name/industry/internal overrides. Replaces
// scripts/domains.json. Editable in-app; survives every reprocess; takes
// precedence over the LLM classifier. RFC §6.
export const employerOverrides = pgTable(
  "employer_overrides",
  {
    domain: text().primaryKey().notNull(),
    // Nullable: an `excluded`-only row (dropped from ingest) has no employer.
    employer_name: text(),
    industry: text(),
    internal: boolean().default(false).notNull(),
    // Domains dropped from ingest entirely (replaces domains.json `_excluded`).
    excluded: boolean().default(false).notNull(),
    edited_by: uuid(),
    edited_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    employerOverridesEditedByFkey: foreignKey({
      columns: [table.edited_by],
      foreignColumns: [users.id],
      name: "employer_overrides_edited_by_fkey",
    }).onDelete("set null"),
    allowReadEmployerOverrides: pgPolicy(
      "Allow read access on employer_overrides",
      { as: "permissive", for: "select", to: ["public"] },
    ),
    allowInsertEmployerOverrides: pgPolicy(
      "Allow insert access on employer_overrides",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateEmployerOverrides: pgPolicy(
      "Allow update access on employer_overrides",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteEmployerOverrides: pgPolicy(
      "Allow delete access on employer_overrides",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

// Human overlay for employer machine fields. NULL column = no override (use
// the machine value on `employers`). ETL never reads/writes this. RFC §3.3.
export const employerCuration = pgTable(
  "employer_curation",
  {
    employer_id: uuid().primaryKey().notNull(),
    name: text(),
    industry: text(),
    edited_by: uuid(),
    edited_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    employerCurationEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "employer_curation_employer_id_fkey",
    }).onDelete("cascade"),
    employerCurationEditedByFkey: foreignKey({
      columns: [table.edited_by],
      foreignColumns: [users.id],
      name: "employer_curation_edited_by_fkey",
    }).onDelete("set null"),
    allowReadEmployerCuration: pgPolicy(
      "Allow read access on employer_curation",
      { as: "permissive", for: "select", to: ["public"] },
    ),
    allowInsertEmployerCuration: pgPolicy(
      "Allow insert access on employer_curation",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateEmployerCuration: pgPolicy(
      "Allow update access on employer_curation",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteEmployerCuration: pgPolicy(
      "Allow delete access on employer_curation",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

// Human overlay for correspondent machine fields. NOTE: is_primary is NOT here
// — it stays on the base `correspondents` table so the partial unique index
// `uq_correspondent_one_primary_per_employer` keeps enforcing one-primary on
// the effective value. RFC §3.4.
export const correspondentCuration = pgTable(
  "correspondent_curation",
  {
    correspondent_id: uuid().primaryKey().notNull(),
    name: text(),
    title: text(),
    phone: text(),
    type: text(),
    department: text(),
    specialization: text(),
    seniority: text(),
    coverage_region: text(),
    linkedin_url: text(),
    bio: text(),
    edited_by: uuid(),
    edited_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    correspondentCurationCorrespondentFkey: foreignKey({
      columns: [table.correspondent_id],
      foreignColumns: [correspondents.id],
      name: "correspondent_curation_correspondent_id_fkey",
    }).onDelete("cascade"),
    correspondentCurationEditedByFkey: foreignKey({
      columns: [table.edited_by],
      foreignColumns: [users.id],
      name: "correspondent_curation_edited_by_fkey",
    }).onDelete("set null"),
    allowReadCorrespondentCuration: pgPolicy(
      "Allow read access on correspondent_curation",
      { as: "permissive", for: "select", to: ["public"] },
    ),
    allowInsertCorrespondentCuration: pgPolicy(
      "Allow insert access on correspondent_curation",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateCorrespondentCuration: pgPolicy(
      "Allow update access on correspondent_curation",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteCorrespondentCuration: pgPolicy(
      "Allow delete access on correspondent_curation",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

// Effective read surfaces (RFC §3): COALESCE the human overlay over the
// machine base, per field. Created in the DB `WITH (security_invoker = on)` so
// RLS keeps evaluating against the caller. All CRM reads go through these.
// `.existing()` — the DDL lives in the migration, not generated by Drizzle.
export const employerEffective = pgView("employer_effective", {
  id: uuid("id").notNull(),
  name: text("name").notNull(),
  normalized_name: text("normalized_name").notNull(),
  industry: text("industry"),
  status: text("status").notNull(),
  curation_status: text("curation_status").notNull(),
  created_at: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  updated_at: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
}).existing();

export const correspondentEffective = pgView("correspondent_effective", {
  id: uuid("id").notNull(),
  employer_id: uuid("employer_id").notNull(),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  type: text("type"),
  is_primary: boolean("is_primary").notNull(),
  source: text("source").notNull(),
  origin: text("origin").notNull(),
  last_edited_by_user_id: uuid("last_edited_by_user_id"),
  last_edited_at: timestamp("last_edited_at", {
    withTimezone: true,
    mode: "string",
  }),
  created_at: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  updated_at: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  // Profile fields sit AFTER updated_at, not next to `type`, because
  // `CREATE OR REPLACE VIEW` can only APPEND columns — it cannot reorder or
  // insert into an existing view's column list. Keep this order identical to
  // 20261006000000_add_correspondent_profile_fields.sql, and append (never
  // insert) when adding the next one.
  department: text("department"),
  specialization: text("specialization"),
  seniority: text("seniority"),
  coverage_region: text("coverage_region"),
  linkedin_url: text("linkedin_url"),
  bio: text("bio"),
}).existing();

export const emails = analytics.table(
  "emails",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    employer_id: uuid(),
    from_address: text().notNull(),
    from_display_name: text(),
    sent_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    direction: text().notNull(),
    filter_status: text().default("processed").notNull(),
    filter_reason: text(),
    processed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    message_id: text(),
    in_reply_to: text(),
    // Workspace bridge (replaces emails ⋈ raw_emails.custodian_email).
    custodian_email: text(),
  },
  (table) => ({
    uqEmailsMessageId: uniqueIndex("uq_emails_message_id")
      .on(table.message_id)
      .where(sql`message_id IS NOT NULL`),
    idxEmailInReplyTo: index("idx_emails_in_reply_to").using(
      "btree",
      table.in_reply_to.asc().nullsLast().op("text_ops"),
    ),
    idxEmailEmployerSent: index("idx_email_employer_sent").using(
      "btree",
      table.employer_id.asc().nullsLast().op("uuid_ops"),
      table.sent_at.asc().nullsLast().op("timestamptz_ops"),
    ),
    idxEmailSentAt: index("idx_email_sent_at").using(
      "btree",
      table.sent_at.asc().nullsLast().op("timestamptz_ops"),
    ),
    idxEmailsCustodianEmail: index("idx_emails_custodian_email").using(
      "btree",
      table.custodian_email.asc().nullsLast().op("text_ops"),
    ),
    emailsEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "emails_employer_id_fkey",
    }).onDelete("set null"),
    allowReadEmails: pgPolicy("Allow read access on emails", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertEmails: pgPolicy("Allow insert access on emails", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    allowUpdateEmails: pgPolicy("Allow update access on emails", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    allowDeleteEmails: pgPolicy("Allow delete access on emails", {
      as: "permissive",
      for: "delete",
      to: ["public"],
      using: sql`true`,
    }),
  }),
);

export const emailTopics = analytics.table(
  "email_topics",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    email_id: uuid().notNull(),
    topic_id: uuid().notNull(),
  },
  (table) => ({
    uqEmailTopic: unique("uq_email_topic").on(table.email_id, table.topic_id),
    emailTopicsEmailFkey: foreignKey({
      columns: [table.email_id],
      foreignColumns: [emails.id],
      name: "email_topics_email_id_fkey",
    }).onDelete("cascade"),
    emailTopicsTopicFkey: foreignKey({
      columns: [table.topic_id],
      foreignColumns: [topics.id],
      name: "email_topics_topic_id_fkey",
    }).onDelete("cascade"),
    allowReadEmailTopics: pgPolicy("Allow read access on email_topics", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    allowInsertEmailTopics: pgPolicy("Allow insert access on email_topics", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    allowUpdateEmailTopics: pgPolicy("Allow update access on email_topics", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    allowDeleteEmailTopics: pgPolicy("Allow delete access on email_topics", {
      as: "permissive",
      for: "delete",
      to: ["public"],
      using: sql`true`,
    }),
  }),
);

export const emailParticipants = analytics.table(
  "email_participants",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    email_id: uuid().notNull(),
    user_id: uuid(),
    correspondent_id: uuid(),
    address: text().notNull(),
    display_name: text(),
    role: emailParticipantRole().notNull(),
  },
  (table) => ({
    uqEmailParticipant: unique("uq_email_participant").on(
      table.email_id,
      table.address,
      table.role,
    ),
    idxEmailParticipantUser: index("idx_email_participant_user").using(
      "btree",
      table.user_id.asc().nullsLast().op("uuid_ops"),
    ),
    idxEmailParticipantCorrespondent: index(
      "idx_email_participant_correspondent",
    ).using("btree", table.correspondent_id.asc().nullsLast().op("uuid_ops")),
    emailParticipantsEmailFkey: foreignKey({
      columns: [table.email_id],
      foreignColumns: [emails.id],
      name: "email_participants_email_id_fkey",
    }).onDelete("cascade"),
    emailParticipantsUserFkey: foreignKey({
      columns: [table.user_id],
      foreignColumns: [users.id],
      name: "email_participants_user_id_fkey",
    }).onDelete("set null"),
    emailParticipantsCorrespondentFkey: foreignKey({
      columns: [table.correspondent_id],
      foreignColumns: [correspondents.id],
      name: "email_participants_correspondent_id_fkey",
    }).onDelete("set null"),
    allowReadEmailParticipants: pgPolicy(
      "Allow read access on email_participants",
      { as: "permissive", for: "select", to: ["public"] },
    ),
    allowInsertEmailParticipants: pgPolicy(
      "Allow insert access on email_participants",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateEmailParticipants: pgPolicy(
      "Allow update access on email_participants",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteEmailParticipants: pgPolicy(
      "Allow delete access on email_participants",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

export const employerTeamMembers = pgTable(
  "employer_team_members",
  {
    employer_id: uuid().notNull(),
    user_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    employerTeamMembersPk: primaryKey({
      columns: [table.employer_id, table.user_id],
    }),
    idxEmployerTeamUser: index("idx_employer_team_user").using(
      "btree",
      table.user_id.asc().nullsLast().op("uuid_ops"),
    ),
    employerTeamMembersEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "employer_team_members_employer_id_fkey",
    }).onDelete("cascade"),
    employerTeamMembersUserFkey: foreignKey({
      columns: [table.user_id],
      foreignColumns: [users.id],
      name: "employer_team_members_user_id_fkey",
    }).onDelete("cascade"),
    allowReadEmployerTeamMembers: pgPolicy(
      "Allow read access on employer_team_members",
      { as: "permissive", for: "select", to: ["public"] },
    ),
    allowInsertEmployerTeamMembers: pgPolicy(
      "Allow insert access on employer_team_members",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateEmployerTeamMembers: pgPolicy(
      "Allow update access on employer_team_members",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteEmployerTeamMembers: pgPolicy(
      "Allow delete access on employer_team_members",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

// ============================================================================
// AI Workforce (MB-143)
// ============================================================================

// Audit entry for a single HITL (human-in-the-loop) decision on a workforce
// run. Stored as an element of ai_workforce_queue.human_decisions. The
// decider is the task creator or the user the intervention was addressed to
// (pending_intervention.asked_user_id — e.g. the insight owner for a scheduled
// refresh); `decided_by_user_id` records which. Entries written before MB-561
// omit it, and their decider is the row's triggered_by_user_id.
export type HumanDecision = {
  tool_call_id: string;
  tool_name: string;
  decision: "approve" | "edit" | "reject";
  edited_args?: Record<string, unknown>;
  rejection_message?: string;
  decided_at: string;
  decided_by_user_id?: string;
  // ask_owner only: the question put to the owner and the answer the agent
  // received (the recommendation when accepted, the owner's text otherwise).
  question?: string;
  answer?: string;
};

// The HITL intervention a workforce run is paused on
// (ai_workforce_queue.pending_intervention). Written when the run enters
// waiting_for_human_input, cleared when a decision queues the resume.
export type PendingIntervention = {
  tool_name: string;
  // The args the agent proposed for the gated call. The decision route
  // rebuilds an `edit` decision from these (the middleware replaces args
  // wholesale on edit).
  tool_args: Record<string, unknown>;
  // Who was asked to decide. Null when nobody could be resolved — only the
  // task creator can then decide.
  asked_user_id: string | null;
  asked_at: string;
};

// Free-form user update message attached to a workforce run via the
// TaskCanvas composer while the run is paused/queued. Consumed FIFO by
// runAgent (read + clear atomically) on the next invoke or resume so the
// agent sees the messages as additional HumanMessage entries.
export type PendingUserMessage = {
  id: string;
  text: string;
  submitted_at: string;
  submitted_by_user_id: string;
};

export const aiWorkforceQueue = pgTable(
  "ai_workforce_queue",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    parent_run_id: uuid(),
    origin_routine_id: uuid(),
    agent_name: text().notNull(),
    trigger_source: triggerSource().notNull(),
    trigger_meta: jsonb()
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    status: workforceStatus().default("pending").notNull(),
    priority: integer().default(0).notNull(),
    resume_token: text(),
    resume_reason: text(),
    workflow_run_id: text(),
    last_heartbeat_at: timestamp({ withTimezone: true, mode: "string" }),
    input: jsonb().$type<Record<string, unknown>>().notNull(),
    output: jsonb().$type<unknown>(),
    error: jsonb().$type<Record<string, unknown>>(),
    cost_cents: integer(),
    token_input: integer(),
    token_output: integer(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    started_at: timestamp({ withTimezone: true, mode: "string" }),
    ended_at: timestamp({ withTimezone: true, mode: "string" }),
    idempotency_key: text(),
    triggered_by_user_id: uuid(),
    title: text(),
    human_decisions: jsonb()
      .$type<HumanDecision[]>()
      .default([])
      .notNull(),
    pending_user_messages: jsonb()
      .$type<PendingUserMessage[]>()
      .default([])
      .notNull(),
    retried_from_id: uuid(),
    pending_intervention: jsonb().$type<PendingIntervention>(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => {
    return {
      idxAiWorkforceQueueWorkspaceId: index(
        "idx_ai_workforce_queue_workspace_id",
      ).using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
      idxAiWorkforceQueueTriggeredBy: index(
        "idx_ai_workforce_queue_triggered_by",
      ).using(
        "btree",
        table.triggered_by_user_id.asc().nullsLast().op("uuid_ops"),
      ),
      aiWorkforceQueueTriggeredByUserIdFkey: foreignKey({
        columns: [table.triggered_by_user_id],
        foreignColumns: [users.id],
        name: "ai_workforce_queue_triggered_by_user_id_fkey",
      }).onDelete("set null"),
      idxAiWorkforceQueueRunning: index(
        "idx_ai_workforce_queue_running",
      ).using("btree", table.status.asc().nullsLast().op("enum_ops")),
      idxAiWorkforceQueueResumeReady: index(
        "idx_ai_workforce_queue_resume_ready",
      ).using(
        "btree",
        table.priority.desc().nullsLast().op("int4_ops"),
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxAiWorkforceQueuePending: index(
        "idx_ai_workforce_queue_pending",
      ).using(
        "btree",
        table.priority.desc().nullsLast().op("int4_ops"),
        table.created_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxAiWorkforceQueueHeartbeat: index(
        "idx_ai_workforce_queue_heartbeat",
      ).using(
        "btree",
        table.last_heartbeat_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxAiWorkforceQueueParent: index(
        "idx_ai_workforce_queue_parent",
      ).using("btree", table.parent_run_id.asc().nullsLast().op("uuid_ops")),
      idxAiWorkforceQueueOriginRoutine: index(
        "idx_ai_workforce_queue_origin_routine",
      ).using(
        "btree",
        table.origin_routine_id.asc().nullsLast().op("uuid_ops"),
      ),
      // An insight's failed refresh runs (MB-559). Retry copies input but not
      // trigger_meta, so the query ORs both expressions.
      idxAiWorkforceQueueRefreshTriggerMetaInsight: index(
        "idx_ai_workforce_queue_refresh_trigger_meta_insight",
      )
        .on(table.workspace_id, sql`(${table.trigger_meta}->>'insight_id')`)
        .where(sql`origin_routine_id IS NOT NULL`),
      idxAiWorkforceQueueRefreshInputInsight: index(
        "idx_ai_workforce_queue_refresh_input_insight",
      )
        .on(table.workspace_id, sql`(${table.input}->>'insight_id')`)
        .where(sql`origin_routine_id IS NOT NULL`),
      // Newest ai_screening task per company (the Pipeline AI Screening panel).
      idxAiWorkforceQueueAiScreeningCompany: index(
        "idx_ai_workforce_queue_ai_screening_company",
      )
        .on(
          table.workspace_id,
          sql`(${table.trigger_meta}->>'company_id')`,
          table.created_at.desc(),
        )
        .where(sql`agent_name = 'ai_screening'`),
      idxAiWorkforceQueueTerminal: index(
        "idx_ai_workforce_queue_terminal",
      ).using("btree", table.ended_at.desc().nullsLast().op("timestamptz_ops")),
      aiWorkforceQueueParentRunIdFkey: foreignKey({
        columns: [table.parent_run_id],
        foreignColumns: [table.id],
        name: "ai_workforce_queue_parent_run_id_fkey",
      }),
      aiWorkforceQueueRetriedFromIdFkey: foreignKey({
        columns: [table.retried_from_id],
        foreignColumns: [table.id],
        name: "ai_workforce_queue_retried_from_id_fkey",
      }).onDelete("set null"),
      // SET NULL so hard-deleting a routine (e.g. via an insight's cascade)
      // keeps the run history and only drops the attribution.
      aiWorkforceQueueOriginRoutineIdFkey: foreignKey({
        columns: [table.origin_routine_id],
        foreignColumns: [routines.id],
        name: "ai_workforce_queue_origin_routine_id_fkey",
      }).onDelete("set null"),
      idxAiWorkforceQueueRetriedFrom: index(
        "idx_ai_workforce_queue_retried_from",
      ).using(
        "btree",
        table.retried_from_id.asc().nullsLast().op("uuid_ops"),
      ),
      aiWorkforceQueueIdempotencyKeyKey: unique(
        "ai_workforce_queue_idempotency_key_key",
      ).on(table.idempotency_key),
      allowDeleteAccessOnAiWorkforceQueue: pgPolicy(
        "Allow delete access on ai_workforce_queue",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnAiWorkforceQueue: pgPolicy(
        "Allow update access on ai_workforce_queue",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnAiWorkforceQueue: pgPolicy(
        "Allow insert access on ai_workforce_queue",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnAiWorkforceQueue: pgPolicy(
        "Allow read access on ai_workforce_queue",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);


export const routines = pgTable(
  "routines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: text().notNull(),
    prompt: text().notNull(),
    schedule_kind: scheduleKind().notNull(),
    schedule_spec: jsonb().$type<Record<string, unknown>>().notNull(),
    cron_expression: text().notNull(),
    timezone: text().default("UTC").notNull(),
    agent_name: text(),
    priority: integer().default(0).notNull(),
    enabled: boolean().default(true).notNull(),
    last_fired_at: timestamp({ withTimezone: true, mode: "string" }),
    next_fire_at: timestamp({ withTimezone: true, mode: "string" }),
    created_by: uuid(),
    updated_by: uuid(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    archived_at: timestamp({ withTimezone: true, mode: "string" }),
    is_system: boolean().default(false).notNull(),
    workspace_id: uuid().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    // Set when this routine refreshes an insight (MB-557). At most one
    // non-archived routine per insight — see uqRoutinesActiveInsight.
    insight_id: uuid().references(() => insights.id, { onDelete: "cascade" }),
    // Why the system paused this routine (MB-560): 'agent_deprecated' or
    // 'agent_incompatible', always with enabled = false. Null for a running
    // routine and for a manual pause, so rebinding the insight resumes only
    // system pauses and never a routine a person switched off.
    paused_reason: text().$type<"agent_deprecated" | "agent_incompatible">(),
    paused_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table) => {
    return {
      routinesPausedReasonChk: check(
        "chk_routines_paused_reason",
        sql`paused_reason IS NULL OR paused_reason IN ('agent_deprecated', 'agent_incompatible')`,
      ),
      idxRoutinesInsightId: index("idx_routines_insight_id").using(
        "btree",
        table.insight_id.asc().nullsLast().op("uuid_ops"),
      ),
      uqRoutinesActiveInsight: uniqueIndex("uq_routines_active_insight")
        .using("btree", table.insight_id.asc().nullsLast().op("uuid_ops"))
        .where(sql`insight_id IS NOT NULL AND archived_at IS NULL`),
      idxRoutinesActiveDue: index("idx_routines_active_due").using(
        "btree",
        table.next_fire_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxRoutinesWorkspaceId: index("idx_routines_workspace_id").using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
      ),
      routinesCreatedByFkey: foreignKey({
        columns: [table.created_by],
        foreignColumns: [users.id],
        name: "routines_created_by_fkey",
      }),
      routinesUpdatedByFkey: foreignKey({
        columns: [table.updated_by],
        foreignColumns: [users.id],
        name: "routines_updated_by_fkey",
      }).onDelete("set null"),
      allowDeleteAccessOnRoutines: pgPolicy(
        "Allow delete access on routines",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnRoutines: pgPolicy(
        "Allow update access on routines",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnRoutines: pgPolicy(
        "Allow insert access on routines",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnRoutines: pgPolicy(
        "Allow read access on routines",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

export const copilotChats = pgTable(
  "copilot_chats",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    user_id: uuid().notNull(),
    title: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    last_active_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    archived_at: timestamp({ withTimezone: true, mode: "string" }),
    // First user message of the chat (raw text) and a SHA-256 of its
    // normalized form. Set once on the first turn; powers the chat cache that
    // detects when a brand-new chat repeats an earlier question.
    first_user_message: text(),
    first_user_message_hash: text(),
    // Effort tier this thread runs at: 'low' | 'medium' | 'high'. Written once
    // by the Auto router (or pinned when the user picks a tier explicitly) and
    // reused on later turns, so Auto costs one routing call per thread and can
    // only escalate, never descend. NULL means "not yet routed".
    effort_tier: text(),
    // The agent this thread runs on (MB-549): a sector agent's registry key, or
    // 'general' for the workspace's general CoPilot. Resolved and written once
    // on the thread's first turn — from the insight the chat was opened on —
    // and reused on every later turn, so one thread never changes agent. NULL
    // means "not yet resolved", mirroring effort_tier.
    agent_key: text(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => {
    return {
      idxCopilotChatsWorkspaceId: index(
        "idx_copilot_chats_workspace_id",
      ).using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
      idxCopilotChatsUserActive: index("idx_copilot_chats_user_active").using(
        "btree",
        table.user_id.asc().nullsLast().op("uuid_ops"),
        table.last_active_at.desc().nullsFirst().op("timestamptz_ops"),
      ),
      idxCopilotChatsFirstMsgHash: index(
        "idx_copilot_chats_first_msg_hash",
      ).using("btree", table.first_user_message_hash.asc().nullsLast()),
      copilotChatsUserIdFkey: foreignKey({
        columns: [table.user_id],
        foreignColumns: [users.id],
        name: "copilot_chats_user_id_fkey",
      }).onDelete("cascade"),
      allowDeleteAccessOnCopilotChats: pgPolicy(
        "Allow delete access on copilot_chats",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnCopilotChats: pgPolicy(
        "Allow update access on copilot_chats",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnCopilotChats: pgPolicy(
        "Allow insert access on copilot_chats",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnCopilotChats: pgPolicy(
        "Allow read access on copilot_chats",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

// API keys for external authorized applications (machine-to-machine access to
// the chat API). The raw token is never stored — only a scrypt hash and a
// short non-secret prefix used to look the row up before verifying the hash.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    key_prefix: text().notNull(),
    key_hash: text().notNull(),
    scopes: text().array().default([]).notNull(),
    last_used_at: timestamp({ withTimezone: true, mode: "string" }),
    revoked_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxApiKeysPrefix: index("idx_api_keys_prefix").using(
        "btree",
        table.key_prefix.asc().nullsLast().op("text_ops"),
      ),
    };
  },
);

// Chat conversations owned by an API key. Mirrors copilot_chats but for
// external clients: the id is used as the agent checkpointer thread_id, and
// ownership is scoped to api_key_id so one client can never resume another's
// conversation.
export const apiChatConversations = pgTable(
  "api_chat_conversations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    api_key_id: uuid().notNull(),
    title: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    last_active_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => {
    return {
      idxApiChatConversationsWorkspaceId: index(
        "idx_api_chat_conversations_workspace_id",
      ).using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
      idxApiChatConversationsKeyActive: index(
        "idx_api_chat_conversations_key_active",
      ).using(
        "btree",
        table.api_key_id.asc().nullsLast().op("uuid_ops"),
        table.last_active_at.desc().nullsFirst().op("timestamptz_ops"),
      ),
      apiChatConversationsApiKeyIdFkey: foreignKey({
        columns: [table.api_key_id],
        foreignColumns: [apiKeys.id],
        name: "api_chat_conversations_api_key_id_fkey",
      }).onDelete("cascade"),
    };
  },
);

// One row per alphasense_search tool invocation, for historical lookback on
// what the agent asked AlphaSense and what came back. chat_thread_id and
// original_question capture the conversation the call happened in (the
// LangGraph thread_id and the user's own un-reformulated question for that
// turn) — both travel via the runtime config, not tool arguments, so the
// model can't fabricate them. Not FK'd to copilot_chats/api_chat_conversations
// since a call can also originate from an AI Workforce run, which has no chat row.
export const alphasenseToolCalls = pgTable(
  "alphasense_tool_calls",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    chat_thread_id: text(),
    original_question: text(),
    prompt: text().notNull(),
    conversation_id: text(),
    status: text().notNull().$type<"success" | "timed_out" | "error" | "not_configured">(),
    response_markdown: text(),
    error_message: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxAlphasenseToolCallsWorkspaceId: index(
        "idx_alphasense_tool_calls_workspace_id",
      ).using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
      idxAlphasenseToolCallsChatThreadId: index(
        "idx_alphasense_tool_calls_chat_thread_id",
      ).using("btree", table.chat_thread_id.asc().nullsLast().op("text_ops")),
      idxAlphasenseToolCallsCreatedAt: index(
        "idx_alphasense_tool_calls_created_at",
      ).using("btree", table.created_at.asc().nullsLast().op("timestamptz_ops")),
      allowDeleteAccessOnAlphasenseToolCalls: pgPolicy(
        "Allow delete access on alphasense_tool_calls",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnAlphasenseToolCalls: pgPolicy(
        "Allow update access on alphasense_tool_calls",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnAlphasenseToolCalls: pgPolicy(
        "Allow insert access on alphasense_tool_calls",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnAlphasenseToolCalls: pgPolicy(
        "Allow read access on alphasense_tool_calls",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

// Generic application settings as a key/value store. Each row holds one JSON
// config blob (e.g. the Insights dashboard targets / conversion band).
// Read and written via AppSettingsRepository.
export const appSettings = pgTable("app_settings", {
  key: text().primaryKey().notNull(),
  value: jsonb().$type<unknown>().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  // User who made the latest change (null when set by a system/internal caller).
  updated_by: uuid().references(() => users.id, { onDelete: "set null" }),
});

// Per-workspace feature-flag overrides. Each row turns one feature on or off
// for one workspace; the effective state is this override when a row exists,
// otherwise the env/catalog default (see src/lib/features/catalog.ts). Read and
// written via FeatureFlagRepository; consulted by @/lib/flags
// (resolveFeatureOverride) for the request's active workspace.
export const featureFlags = pgTable(
  "feature_flags",
  {
    workspace_id: uuid().notNull(),
    feature_key: text().notNull(),
    enabled: boolean().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    // User who last toggled this flag (null when set by a system/internal caller).
    updated_by: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (table) => {
    return {
      idxFeatureFlagsWorkspaceId: index("idx_feature_flags_workspace_id").using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
      ),
      featureFlagsWorkspaceIdFkey: foreignKey({
        columns: [table.workspace_id],
        foreignColumns: [workspaces.id],
        name: "feature_flags_workspace_id_fkey",
      }).onDelete("cascade"),
      featureFlagsPkey: primaryKey({
        columns: [table.workspace_id, table.feature_key],
        name: "feature_flags_pkey",
      }),
    };
  },
);

// Per-workspace column layouts for the managed data tables (pipeline inbound /
// outbound, master data, smart files, market screening). One row = one table's
// layout — column order, hidden columns, and collapsible column groups — shared
// by every member of the workspace rather than saved per browser. `layout` holds
// a ColumnLayoutState blob (see src/lib/table/columnLayout.ts). Read/written via
// WorkspaceTableLayoutRepository.
export const workspaceTableLayouts = pgTable(
  "workspace_table_layouts",
  {
    workspace_id: uuid().notNull(),
    // Stable table identifier passed to useColumnLayout (e.g.
    // "pipeline-inbound:active", "master-data").
    table_id: text().notNull(),
    layout: jsonb().$type<unknown>().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    // User who last saved this layout (null when written by a system caller).
    updated_by: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (table) => {
    return {
      workspaceTableLayoutsWorkspaceIdFkey: foreignKey({
        columns: [table.workspace_id],
        foreignColumns: [workspaces.id],
        name: "workspace_table_layouts_workspace_id_fkey",
      }).onDelete("cascade"),
      workspaceTableLayoutsPkey: primaryKey({
        columns: [table.workspace_id, table.table_id],
        name: "workspace_table_layouts_pkey",
      }),
    };
  },
);

// In-app feedback submissions (MB-480). Each row is one titled message a user
// sent from the feedback form; on write the app also emails nico.alimin@smma.id
// and files a Jira ticket, stamping `jira_issue_key` back once that ticket exists.
// Read/written via FeedbackRepository.
export const feedback = pgTable(
  "feedback",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    user_id: uuid(),
    title: text().notNull(),
    message: text().notNull(),
    jira_issue_key: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    feedbackUserIdFkey: foreignKey({
      columns: [table.user_id],
      foreignColumns: [users.id],
      name: "feedback_user_id_fkey",
    }).onDelete("set null"),
    idxFeedbackWorkspaceId: index("idx_feedback_workspace_id").using(
      "btree",
      table.workspace_id.asc().nullsLast().op("uuid_ops"),
    ),
  }),
);

// One row per user who has accepted the Sync/Terms consent screen. A user
// with no row here has not consented — gates both app access (see
// `hasConsented` on the session/JWT) and email-sync eligibility (see
// `UserWorkspaceRepository.findSyncedCustodianEmails`, which requires both
// `is_email_synced = true` AND a row here). Re-accepting a later
// `policy_version` upserts this row rather than inserting a new one.
export const userConsents = pgTable(
  "user_consents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    user_id: uuid().notNull(),
    policy_version: text().notNull(),
    consented_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userConsentsUserIdFkey: foreignKey({
      columns: [table.user_id],
      foreignColumns: [users.id],
      name: "user_consents_user_id_fkey",
    }).onDelete("cascade"),
    userConsentsUserIdKey: unique("user_consents_user_id_key").on(
      table.user_id,
    ),
  }),
);

// "Today's Recap" daily pipeline pulse cache. One row per workspace per UTC day
// stores the assembled pulse (deterministic scoreboard + LLM narration): the
// first request of the day computes + narrates and upserts it, later requests
// read it back. Regenerated on an explicit refresh (upsert on the same day).
// Read/written via DailyPulseRepository.
export const dailyPulse = pgTable(
  "daily_pulse",
  {
    workspace_id: uuid().notNull(),
    pulse_date: date().notNull(),
    payload: jsonb().$type<unknown>().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxDailyPulseWorkspaceId: index("idx_daily_pulse_workspace_id").using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
      ),
      dailyPulseWorkspaceIdFkey: foreignKey({
        columns: [table.workspace_id],
        foreignColumns: [workspaces.id],
        name: "daily_pulse_workspace_id_fkey",
      }).onDelete("cascade"),
      dailyPulsePkey: primaryKey({
        columns: [table.workspace_id, table.pulse_date],
        name: "daily_pulse_pkey",
      }),
    };
  },
);

// ---------------------------------------------------------------------------
// Company voting (Investment Committee vote on one company)
// ---------------------------------------------------------------------------

/**
 * One round of voting on a company. A company can only have a single `active`
 * session at a time (enforced by the partial unique index in the migration);
 * concluded/cancelled rounds are kept forever so "Vote again" builds history
 * rather than overwriting it.
 *
 * The `ai_*` columns hold the post-conclusion synthesis rendered in the results
 * view: `ai_synthesis` is the narrative paragraph, `ai_key_positives` /
 * `ai_key_concerns` are bullet arrays, and `ai_opinion_*` snapshot the
 * company's standing AI Opinion at the moment the vote closed (the company row
 * can be re-evaluated later; the results card must not silently change).
 */
export const companyVoteSessions = pgTable(
  "company_vote_sessions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    company_id: uuid().notNull(),
    workspace_id: uuid().notNull(),
    initiated_by: uuid().notNull(),
    status: voteSessionStatus().default("active").notNull(),
    /** Ballots are auto-submitted once this passes (cron sweep). */
    deadline_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    /**
     * Legacy: rounds used to be opened for "X days Y hours" and these held that
     * verbatim. The initiator now picks an absolute deadline, so nothing writes
     * them any more and they default to 0 — kept (rather than dropped) because
     * historical rounds still carry the window they were opened with.
     */
    duration_days: integer().default(0).notNull(),
    duration_hours: integer().default(0).notNull(),
    concluded_at: timestamp({ withTimezone: true, mode: "string" }),
    cancelled_at: timestamp({ withTimezone: true, mode: "string" }),
    ai_status: analysisJobStatus().default("pending").notNull(),
    ai_synthesis: text(),
    ai_key_positives: jsonb().$type<string[]>(),
    ai_key_concerns: jsonb().$type<string[]>(),
    ai_opinion_verdict: text(),
    ai_opinion_summary: text(),
    /**
     * The AI Opinion's own ballot — it counts as one voter. Derived from
     * `ai_opinion_verdict` when the round closes (see `aiVerdictToVoteChoice`),
     * so it is null while the round is still open.
     */
    ai_vote_choice: voteChoice(),
    ai_error: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    idxCompanyVoteSessionsCompanyId: index(
      "idx_company_vote_sessions_company_id",
    ).using("btree", table.company_id.asc().nullsLast().op("uuid_ops")),
    idxCompanyVoteSessionsWorkspaceId: index(
      "idx_company_vote_sessions_workspace_id",
    ).using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
    // Backs the deadline sweep — the cron scans (status, deadline_at) only.
    idxCompanyVoteSessionsDeadline: index(
      "idx_company_vote_sessions_deadline",
    ).using(
      "btree",
      table.status.asc().nullsLast().op("enum_ops"),
      table.deadline_at.asc().nullsLast().op("timestamptz_ops"),
    ),
    companyVoteSessionsCompanyIdFkey: foreignKey({
      columns: [table.company_id],
      foreignColumns: [companies.id],
      name: "company_vote_sessions_company_id_fkey",
    }).onDelete("cascade"),
    companyVoteSessionsWorkspaceIdFkey: foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
      name: "company_vote_sessions_workspace_id_fkey",
    }).onDelete("cascade"),
    // At most one open round per company — "Vote again" must conclude or cancel
    // the previous round first, and two racing "Start Vote" clicks can't both win.
    uqCompanyVoteSessionsOneActive: uniqueIndex(
      "uq_company_vote_sessions_one_active",
    )
      .using("btree", table.company_id.asc().nullsLast().op("uuid_ops"))
      .where(sql`status = 'active'`),
    // RESTRICT, not cascade: deleting a user must never silently delete a
    // concluded round. Company/workspace deletion does cascade — a vote on a
    // company that no longer exists has nothing to say.
    companyVoteSessionsInitiatedByFkey: foreignKey({
      columns: [table.initiated_by],
      foreignColumns: [users.id],
      name: "company_vote_sessions_initiated_by_fkey",
    }).onDelete("restrict"),
  }),
);

/**
 * One voter's ballot inside a session. Rows are created up-front (one per
 * selected voter) so "who still owes a vote" is a plain query rather than a set
 * difference, and so a voter who never opens the tab still gets an
 * auto-submitted `inconclusive` ballot at the deadline.
 *
 * `body_html` is the WYSIWYG rationale, stored as sanitized HTML.
 */
export const companyVoteBallots = pgTable(
  "company_vote_ballots",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    vote_session_id: uuid().notNull(),
    voter_id: uuid().notNull(),
    choice: voteChoice(),
    body_html: text(),
    status: voteBallotStatus().default("draft").notNull(),
    submitted_at: timestamp({ withTimezone: true, mode: "string" }),
    /** True when the deadline sweep submitted this instead of the voter. */
    auto_submitted: boolean().default(false).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    idxCompanyVoteBallotsSessionId: index(
      "idx_company_vote_ballots_session_id",
    ).using("btree", table.vote_session_id.asc().nullsLast().op("uuid_ops")),
    idxCompanyVoteBallotsVoterId: index(
      "idx_company_vote_ballots_voter_id",
    ).using("btree", table.voter_id.asc().nullsLast().op("uuid_ops")),
    companyVoteBallotsSessionIdFkey: foreignKey({
      columns: [table.vote_session_id],
      foreignColumns: [companyVoteSessions.id],
      name: "company_vote_ballots_vote_session_id_fkey",
    }).onDelete("cascade"),
    // RESTRICT, not cascade: losing a voter must not rewrite a recorded tally.
    companyVoteBallotsVoterIdFkey: foreignKey({
      columns: [table.voter_id],
      foreignColumns: [users.id],
      name: "company_vote_ballots_voter_id_fkey",
    }).onDelete("restrict"),
    companyVoteBallotsSessionVoterKey: unique(
      "company_vote_ballots_session_voter_key",
    ).on(table.vote_session_id, table.voter_id),
  }),
);


// ── Data Navigator RSS news lake (schema `rss`) ─────────────────────────────
// Pipeline-owned and GLOBAL: no workspace_id anywhere. The feed catalog and
// the ingested news are shared by every workspace by design.
//
// Indexes and CHECK constraints live in the hand-authored SQL migration
// (data-pipeline/migrations/*_rss_schema.sql), not here — the HNSW vector
// index has no Drizzle expression, and keeping all of them in one place beats
// splitting them across two sources of truth.
export const rss = pgSchema("rss");

export const RSS_CATEGORIES = [
  "expert_insights",
  "market_assessment",
  "new_funding",
  "ma_partnerships",
  "industry_reports",
] as const;
export type RssCategory = (typeof RSS_CATEGORIES)[number];

export type RssFeedTier = "curated" | "query";
export type RssFeedStatus = "active" | "paused" | "dead";
export type RssRelevance = "pending" | "selected" | "rejected";
export type RssContentStatus = "none" | "pending" | "fetched" | "failed";
/**
 * Translation lifecycle for a non-English item.
 *
 * `none` — the translate stage has not looked at it yet. `not_needed` — it
 * looked, and the text is already English (or too short to judge, in which
 * case we deliberately don't spend a model call). `pending` — an attempt
 * failed with budget left, so the next run retries. `translated` — the
 * `*_en` columns are populated. `failed` — budget exhausted; the item stays
 * readable in its original language.
 */
export type RssTranslationStatus =
  | "none"
  | "not_needed"
  | "pending"
  | "translated"
  | "failed";

export const rssFeeds = rss.table("feeds", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  category: text().$type<RssCategory>().notNull(),
  source_name: text().notNull(),
  feed_url: text().notNull(),
  region: text(),
  tier: text().$type<RssFeedTier>().default("curated").notNull(),
  status: text().$type<RssFeedStatus>().default("active").notNull(),
  notes: text(),
  etag: text(),
  last_modified: text(),
  last_polled_at: timestamp({ withTimezone: true, mode: "string" }),
  last_success_at: timestamp({ withTimezone: true, mode: "string" }),
  consecutive_failures: integer().default(0).notNull(),
  created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const rssItems = rss.table("items", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  item_hash: text().notNull(),
  feed_id: uuid(),
  category: text().$type<RssCategory>().notNull(),
  source_name: text().notNull(),
  region: text(),
  feed_tier: text().$type<RssFeedTier>().default("curated").notNull(),
  title: text().notNull(),
  link: text().notNull(),
  summary: text(),
  authors: text(),
  tags: text(),
  published_at: timestamp({ withTimezone: true, mode: "string" }),
  ingested_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  relevance: text().$type<RssRelevance>().default("pending").notNull(),
  relevance_score: real(),
  llm_labels: jsonb().$type<RssItemLabels>(),
  classified_at: timestamp({ withTimezone: true, mode: "string" }),
  content_status: text().$type<RssContentStatus>().default("none").notNull(),
  content_text: text(),
  content_fetched_at: timestamp({ withTimezone: true, mode: "string" }),
  content_attempts: integer().default(0).notNull(),
  content_error: text(),
  // Translation. The original `title`/`summary`/`content_text` above are never
  // overwritten — the reading pane can toggle back to them — so the English
  // rendering lives in parallel `*_en` columns.
  /** Detected ISO 639-1 code of the ORIGINAL text (`en`, `ja`, `de`, …). */
  language: text(),
  translation_status: text().$type<RssTranslationStatus>().default("none").notNull(),
  title_en: text(),
  summary_en: text(),
  content_text_en: text(),
  translated_at: timestamp({ withTimezone: true, mode: "string" }),
  translation_attempts: integer().default(0).notNull(),
  translation_error: text(),
  embedded_at: timestamp({ withTimezone: true, mode: "string" }),
});

/** Shape written into `rss.items.llm_labels` by the classification stage. */
export interface RssItemLabels {
  companies: string[];
  topics: string[];
  reason: string;
}

export const rssItemChunks = rss.table("item_chunks", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  item_id: uuid().notNull(),
  chunk_index: integer().notNull(),
  text: text().notNull(),
  embedding: vector({ dimensions: 1024 }).notNull(),
  created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const rssIngestRuns = rss.table("ingest_runs", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  kind: text().$type<"poll" | "enrich">().notNull(),
  started_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  finished_at: timestamp({ withTimezone: true, mode: "string" }),
  stats: jsonb().default({}).notNull(),
  error: text(),
});
// ===== Fund Ledger v2 =====

// Enums (prefixed with fl_)
export const flInvestorType = pgEnum("fl_investor_type", [
  "individual",
  "institution",
  "internal_entity",
]);

export const flOwnershipBasis = pgEnum("fl_ownership_basis", [
  "units",
  "commitment",
  "capital_account",
]);

export const flFundStatus = pgEnum("fl_fund_status", [
  "raising",
  "investing",
  "harvesting",
  "liquidated",
]);

export const flAssetKind = pgEnum("fl_asset_kind", [
  "equity",
  "loan",
  "note",
  "safe",
  "real_estate",
  "listed_security",
  "cash",
  "other",
]);

export const flPositionStatus = pgEnum("fl_position_status", [
  "open",
  "closed",
]);

export const flEntryType = pgEnum("fl_entry_type", [
  "commitment",
  "commitment_transfer",
  "paid_in",
  "distribution",
  "redemption",
  "unit_transfer",
  "buy",
  "sell",
  "income",
  "expense",
  "adjustment",
  "cash_movement",
]);

export const flEventStatus = pgEnum("fl_event_status", [
  "posted",
  "reversed",
]);

export const flDataStatus = pgEnum("fl_data_status", [
  "verified",
  "needs_verification",
]);

export const flValuationMethod = pgEnum("fl_valuation_method", [
  "at_cost",
  "fundraise_round",
  "secondary_sale",
  "listed_price",
  "comparables",
  "capital_account_statement",
  "appraisal",
  "other",
]);

// Tables (11)

// 1. fl_investors — LPs, group holding entities, and internal balance-sheet entities.
export const flInvestors = pgTable("fl_investors", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text().notNull(),
  canonical_name: text().notNull(),
  legal_name: text(),
  english_name: text(),
  investor_type: flInvestorType().notNull(),
  country: text(),
  parent_investor_id: uuid(),
  notes: text(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flInvestorsParentFkey: foreignKey({
    columns: [table.parent_investor_id],
    foreignColumns: [table.id],
    name: "fl_investors_parent_investor_id_fkey",
  }).onDelete("set null"),
  flInvestorsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_investors_created_by_fkey",
  }).onDelete("set null"),
  flInvestorsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_investors_updated_by_fkey",
  }).onDelete("set null"),
  idxFlInvestorsWorkspaceId: index("idx_fl_investors_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
  flInvestorsWorkspaceCanonicalNameUniq: uniqueIndex("fl_investors_workspace_canonical_name_uniq")
    .on(table.workspace_id, table.canonical_name),
}));

// 2. fl_funds — unitized / commitment-based investment vehicles (managed or external).
export const flFunds = pgTable("fl_funds", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text().notNull(),
  canonical_name: text().notNull(),
  legal_name: text(),
  english_name: text(),
  registration_no: text(),
  managed: boolean().default(false).notNull(),
  ownership_basis: flOwnershipBasis().notNull(),
  base_currency: char({ length: 3 }).default("USD").notNull(),
  vintage_year: integer(),
  fund_life_years: integer(),
  status: flFundStatus().default("investing").notNull(),
  mgmt_fee_rate: numeric({ precision: 9, scale: 6 }),
  carry_rate: numeric({ precision: 9, scale: 6 }),
  preferred_return_rate: numeric({ precision: 9, scale: 6 }),
  description: text(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flFundsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_funds_created_by_fkey",
  }).onDelete("set null"),
  flFundsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_funds_updated_by_fkey",
  }).onDelete("set null"),
  idxFlFundsWorkspaceId: index("idx_fl_funds_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
  flFundsWorkspaceCanonicalNameUniq: uniqueIndex("fl_funds_workspace_canonical_name_uniq")
    .on(table.workspace_id, table.canonical_name),
}));

// 3. fl_assets — investable assets (companies, loans, notes, safes, real estate, etc.).
export const flAssets = pgTable("fl_assets", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text().notNull(),
  canonical_name: text().notNull(),
  legal_name: text(),
  english_name: text(),
  asset_kind: flAssetKind().notNull(),
  country: text(),
  sector: text(),
  sub_sector: text(),
  instrument_terms: jsonb().default({}).notNull(),
  description: text(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flAssetsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_assets_created_by_fkey",
  }).onDelete("set null"),
  flAssetsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_assets_updated_by_fkey",
  }).onDelete("set null"),
  idxFlAssetsWorkspaceId: index("idx_fl_assets_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
  flAssetsWorkspaceCanonicalNameUniq: uniqueIndex("fl_assets_workspace_canonical_name_uniq")
    .on(table.workspace_id, table.canonical_name),
  flAssetsSystemCashCurrencyUniq: uniqueIndex("fl_assets_system_cash_currency_uniq")
    .on(table.workspace_id, sql`(${table.instrument_terms}->>'currency')`)
    .where(sql`${table.asset_kind} = 'cash' AND ${table.instrument_terms}->>'system_cash' = 'true'`),
}));

// 4. fl_funding_sources — attribution dimension for where money originated.
export const flFundingSources = pgTable("fl_funding_sources", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text().notNull(),
  canonical_name: text().notNull(),
  source_type: text(),
  owner_investor_id: uuid(),
  currency: char({ length: 3 }),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flFundingSourcesOwnerFkey: foreignKey({
    columns: [table.owner_investor_id],
    foreignColumns: [flInvestors.id],
    name: "fl_funding_sources_owner_investor_id_fkey",
  }).onDelete("set null"),
  flFundingSourcesCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_funding_sources_created_by_fkey",
  }).onDelete("set null"),
  flFundingSourcesUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_funding_sources_updated_by_fkey",
  }).onDelete("set null"),
  idxFlFundingSourcesWorkspaceId: index("idx_fl_funding_sources_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
  flFundingSourcesWorkspaceCanonicalNameUniq: uniqueIndex("fl_funding_sources_workspace_canonical_name_uniq")
    .on(table.workspace_id, table.canonical_name),
}));

// 5. fl_positions — accounts representing WHO holds WHAT (fund participation or asset holding).
export const flPositions = pgTable("fl_positions", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  holder_investor_id: uuid(),
  holder_fund_id: uuid(),
  fund_id: uuid(),
  asset_id: uuid(),
  holder_source_of_fund_id: uuid(),
  status: flPositionStatus().default("open").notNull(),
  opened_at: date(),
  closed_at: date(),
  notes: text(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flPositionsHolderInvestorFkey: foreignKey({
    columns: [table.holder_investor_id],
    foreignColumns: [flInvestors.id],
    name: "fl_positions_holder_investor_id_fkey",
  }).onDelete("cascade"),
  flPositionsHolderFundFkey: foreignKey({
    columns: [table.holder_fund_id],
    foreignColumns: [flFunds.id],
    name: "fl_positions_holder_fund_id_fkey",
  }).onDelete("cascade"),
  flPositionsFundFkey: foreignKey({
    columns: [table.fund_id],
    foreignColumns: [flFunds.id],
    name: "fl_positions_fund_id_fkey",
  }).onDelete("cascade"),
  flPositionsAssetFkey: foreignKey({
    columns: [table.asset_id],
    foreignColumns: [flAssets.id],
    name: "fl_positions_asset_id_fkey",
  }).onDelete("cascade"),
  flPositionsHolderSourceOfFundFkey: foreignKey({
    columns: [table.holder_source_of_fund_id],
    foreignColumns: [flFundingSources.id],
    name: "fl_positions_holder_source_of_fund_id_fkey",
  }).onDelete("restrict"),
  flPositionsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_positions_created_by_fkey",
  }).onDelete("set null"),
  flPositionsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_positions_updated_by_fkey",
  }).onDelete("set null"),
  idxFlPositionsWorkspaceId: index("idx_fl_positions_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
  idxFlPositionsFundId: index("idx_fl_positions_fund_id")
    .using("btree", table.fund_id.asc().nullsLast().op("uuid_ops")),
  idxFlPositionsAssetId: index("idx_fl_positions_asset_id")
    .using("btree", table.asset_id.asc().nullsLast().op("uuid_ops")),
  idxFlPositionsHolderInvestorId: index("idx_fl_positions_holder_investor_id")
    .using("btree", table.holder_investor_id.asc().nullsLast().op("uuid_ops")),
  idxFlPositionsHolderFundId: index("idx_fl_positions_holder_fund_id")
    .using("btree", table.holder_fund_id.asc().nullsLast().op("uuid_ops")),
  idxFlPositionsHolderSourceOfFundId: index("idx_fl_positions_holder_source_of_fund_id")
    .using("btree", table.holder_source_of_fund_id.asc().nullsLast().op("uuid_ops")),
  // UNIQUE NULLS NOT DISTINCT (holder_investor_id, holder_fund_id, fund_id, asset_id, holder_source_of_fund_id)
  // is defined in SQL migration because Drizzle TS API does not support NULLS NOT DISTINCT.
}));

// 6. fl_source_records — import provenance tracking.
export const flSourceRecords = pgTable("fl_source_records", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  file_id: text().notNull(),
  sheet_name: text(),
  row_number: integer(),
  raw_payload: jsonb().notNull(),
  payload_hash: text().notNull(),
  imported_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flSourceRecordsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_source_records_created_by_fkey",
  }).onDelete("set null"),
  flSourceRecordsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_source_records_updated_by_fkey",
  }).onDelete("set null"),
  idxFlSourceRecordsWorkspaceId: index("idx_fl_source_records_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
  // UNIQUE NULLS NOT DISTINCT (workspace_id, file_id, sheet_name, row_number, payload_hash)
  // is defined in SQL migration because Drizzle TS API does not support NULLS NOT DISTINCT.
}));

// 8. fl_business_events — grouping headers and correction markers.
export const flBusinessEvents = pgTable("fl_business_events", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  event_date: date().notNull(),
  description: text(),
  status: flEventStatus().default("posted").notNull(),
  reversal_of_event_id: uuid(),
  source_record_id: uuid(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flBusinessEventsReversalFkey: foreignKey({
    columns: [table.reversal_of_event_id],
    foreignColumns: [table.id],
    name: "fl_business_events_reversal_of_event_id_fkey",
  }).onDelete("set null"),
  flBusinessEventsSourceRecordFkey: foreignKey({
    columns: [table.source_record_id],
    foreignColumns: [flSourceRecords.id],
    name: "fl_business_events_source_record_id_fkey",
  }).onDelete("set null"),
  flBusinessEventsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_business_events_created_by_fkey",
  }).onDelete("set null"),
  flBusinessEventsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_business_events_updated_by_fkey",
  }).onDelete("set null"),
  idxFlBusinessEventsWorkspaceId: index("idx_fl_business_events_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
}));

export type BusinessEventRevisionSnapshot = {
  event: typeof flBusinessEvents.$inferSelect;
  entries: (typeof flLedgerEntries.$inferSelect)[];
  allocations: (typeof flLedgerEntryFundingAllocations.$inferSelect)[];
};

// 8b. fl_business_event_revisions — pre-edit snapshots for event revisions.
export const flBusinessEventRevisions = pgTable("fl_business_event_revisions", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  business_event_id: uuid().notNull(),
  revision_no: integer().notNull(),
  snapshot: jsonb().$type<BusinessEventRevisionSnapshot>().notNull(),
  changed_by: uuid(),
  changed_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flBusinessEventRevisionsBusinessEventFkey: foreignKey({
    columns: [table.business_event_id],
    foreignColumns: [flBusinessEvents.id],
    name: "fl_business_event_revisions_business_event_id_fkey",
  }).onDelete("cascade"),
  flBusinessEventRevisionsChangedByFkey: foreignKey({
    columns: [table.changed_by],
    foreignColumns: [users.id],
    name: "fl_business_event_revisions_changed_by_fkey",
  }).onDelete("set null"),
  flBusinessEventRevisionsEventRevisionUniq: unique("fl_business_event_revisions_business_event_id_revision_no_key")
    .on(table.business_event_id, table.revision_no),
  idxFlBusinessEventRevisionsWorkspaceId: index("idx_fl_business_event_revisions_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
  idxFlBusinessEventRevisionsBusinessEventId: index("idx_fl_business_event_revisions_business_event_id")
    .using("btree", table.business_event_id.asc().nullsLast().op("uuid_ops")),
}));

// 9. fl_ledger_entries — economic facts against positions.
export const flLedgerEntries = pgTable("fl_ledger_entries", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  position_id: uuid().notNull(),
  business_event_id: uuid().notNull(),
  entry_date: date().notNull(),
  entry_type: flEntryType().notNull(),
  sub_type: text(),
  is_reversal: boolean().default(false).notNull(),
  commitment_delta: numeric({ precision: 38, scale: 8 }).default("0").notNull(),
  quantity_delta: numeric({ precision: 38, scale: 8 }).default("0").notNull(),
  valuation_delta: numeric({ precision: 38, scale: 8 }).default("0").notNull(),
  cash_delta: numeric({ precision: 38, scale: 8 }).default("0").notNull(),
  currency: char({ length: 3 }).notNull(),
  fx_rate: numeric({ precision: 38, scale: 12 }),
  price_per_unit: numeric({ precision: 38, scale: 8 }),
  counterparty_position_id: uuid(),
  data_status: flDataStatus().default("verified").notNull(),
  source_record_id: uuid(),
  source_ledger_entry_id: uuid(),
  notes: text(),
  created_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flLedgerEntriesPositionFkey: foreignKey({
    columns: [table.position_id],
    foreignColumns: [flPositions.id],
    name: "fl_ledger_entries_position_id_fkey",
  }).onDelete("restrict"),
  flLedgerEntriesBusinessEventFkey: foreignKey({
    columns: [table.business_event_id],
    foreignColumns: [flBusinessEvents.id],
    name: "fl_ledger_entries_business_event_id_fkey",
  }).onDelete("restrict"),
  flLedgerEntriesCounterpartyPositionFkey: foreignKey({
    columns: [table.counterparty_position_id],
    foreignColumns: [flPositions.id],
    name: "fl_ledger_entries_counterparty_position_id_fkey",
  }).onDelete("restrict"),
  flLedgerEntriesSourceRecordFkey: foreignKey({
    columns: [table.source_record_id],
    foreignColumns: [flSourceRecords.id],
    name: "fl_ledger_entries_source_record_id_fkey",
  }).onDelete("set null"),
  flLedgerEntriesSourceLedgerEntryFkey: foreignKey({
    columns: [table.source_ledger_entry_id],
    foreignColumns: [table.id],
    name: "fl_ledger_entries_source_ledger_entry_id_fkey",
  }).onDelete("restrict"),
  flLedgerEntriesCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_ledger_entries_created_by_fkey",
  }).onDelete("set null"),
  idxFlLedgerEntriesPositionEntryDate: index("idx_fl_ledger_entries_position_entry_date")
    .on(table.position_id, table.entry_date),
  idxFlLedgerEntriesBusinessEventId: index("idx_fl_ledger_entries_business_event_id")
    .on(table.business_event_id),
  flLedgerEntriesSourcePositionUniq: uniqueIndex("fl_ledger_entries_source_position_uniq")
    .on(table.source_ledger_entry_id, table.position_id)
    .where(sql`${table.source_ledger_entry_id} IS NOT NULL`),
}));

// 10. fl_ledger_entry_funding_allocations — many-to-many funding pool attribution.
export const flLedgerEntryFundingAllocations = pgTable("fl_ledger_entry_funding_allocations", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  ledger_entry_id: uuid().notNull(),
  funding_source_id: uuid().notNull(),
  amount: numeric({ precision: 38, scale: 8 }).notNull(),
  created_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flAllocationsLedgerEntryFkey: foreignKey({
    columns: [table.ledger_entry_id],
    foreignColumns: [flLedgerEntries.id],
    name: "fl_ledger_entry_funding_allocations_ledger_entry_id_fkey",
  }).onDelete("cascade"),
  flAllocationsFundingSourceFkey: foreignKey({
    columns: [table.funding_source_id],
    foreignColumns: [flFundingSources.id],
    name: "fl_ledger_entry_funding_allocations_funding_source_id_fkey",
  }).onDelete("restrict"),
  flAllocationsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_ledger_entry_funding_allocations_created_by_fkey",
  }).onDelete("set null"),
  flAllocationsUniq: unique("fl_ledger_entry_funding_allocations_entry_source_uniq")
    .on(table.ledger_entry_id, table.funding_source_id),
  idxFlAllocationsFundingSourceId: index("idx_fl_allocations_funding_source_id")
    .using("btree", table.funding_source_id.asc().nullsLast().op("uuid_ops")),
}));

// 11. fl_valuations — time-series valuations for assets, funds, and positions.
export const flValuations = pgTable("fl_valuations", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  asset_id: uuid(),
  fund_id: uuid(),
  position_id: uuid(),
  as_of_date: date().notNull(),
  valuation_method: flValuationMethod(),
  currency: char({ length: 3 }).default("USD").notNull(),
  market_value: numeric({ precision: 38, scale: 8 }),
  price_per_unit: numeric({ precision: 38, scale: 8 }),
  units_outstanding: numeric({ precision: 38, scale: 8 }),
  gross_value: numeric({ precision: 38, scale: 8 }),
  net_value: numeric({ precision: 38, scale: 8 }),
  data_status: flDataStatus().default("verified").notNull(),
  source_record_id: uuid(),
  notes: text(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flValuationsAssetFkey: foreignKey({
    columns: [table.asset_id],
    foreignColumns: [flAssets.id],
    name: "fl_valuations_asset_id_fkey",
  }).onDelete("cascade"),
  flValuationsFundFkey: foreignKey({
    columns: [table.fund_id],
    foreignColumns: [flFunds.id],
    name: "fl_valuations_fund_id_fkey",
  }).onDelete("cascade"),
  flValuationsPositionFkey: foreignKey({
    columns: [table.position_id],
    foreignColumns: [flPositions.id],
    name: "fl_valuations_position_id_fkey",
  }).onDelete("cascade"),
  flValuationsSourceRecordFkey: foreignKey({
    columns: [table.source_record_id],
    foreignColumns: [flSourceRecords.id],
    name: "fl_valuations_source_record_id_fkey",
  }).onDelete("set null"),
  flValuationsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_valuations_created_by_fkey",
  }).onDelete("set null"),
  flValuationsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_valuations_updated_by_fkey",
  }).onDelete("set null"),
  idxFlValuationsAssetId: index("idx_fl_valuations_asset_id")
    .using("btree", table.asset_id.asc().nullsLast().op("uuid_ops")),
  idxFlValuationsFundId: index("idx_fl_valuations_fund_id")
    .using("btree", table.fund_id.asc().nullsLast().op("uuid_ops")),
  idxFlValuationsPositionId: index("idx_fl_valuations_position_id")
    .using("btree", table.position_id.asc().nullsLast().op("uuid_ops")),
  idxFlValuationsAsOfDate: index("idx_fl_valuations_as_of_date")
    .using("btree", table.as_of_date.asc().nullsLast()),
  // UNIQUE NULLS NOT DISTINCT (asset_id, fund_id, position_id, as_of_date)
  // is defined in SQL migration because Drizzle TS API does not support NULLS NOT DISTINCT.
}));

// 12. fl_corporate_actions — a corporate action on a company asset that changes our
// ownership % (funding_round / opening_stake / other). A priced round keeps its
// inputs for audit. It tracks ownership % only; it writes no fl_valuations rows.
export const flCorporateActions = pgTable("fl_corporate_actions", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  asset_id: uuid().notNull(),
  action_type: text().default("funding_round").notNull(),
  action_date: date().notNull(),
  label: text(),
  // Required for a funding_round; null for the other action types.
  currency: char({ length: 3 }),
  pre_money: numeric({ precision: 38, scale: 8 }),
  round_size: numeric({ precision: 38, scale: 8 }),
  notes: text(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flCorporateActionsAssetFkey: foreignKey({
    columns: [table.asset_id],
    foreignColumns: [flAssets.id],
    name: "fl_corporate_actions_asset_id_fkey",
  }).onDelete("cascade"),
  flCorporateActionsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fl_corporate_actions_created_by_fkey",
  }).onDelete("set null"),
  flCorporateActionsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fl_corporate_actions_updated_by_fkey",
  }).onDelete("set null"),
  flCorporateActionsActionTypeCheck: check(
    "fl_corporate_actions_action_type_check",
    sql`${table.action_type} IN ('funding_round', 'opening_stake', 'other')`,
  ),
  flCorporateActionsTermsRequired: check(
    "fl_corporate_actions_terms_required",
    sql`${table.action_type} <> 'funding_round' OR (${table.currency} IS NOT NULL AND ${table.pre_money} IS NOT NULL AND ${table.round_size} IS NOT NULL)`,
  ),
  flCorporateActionsPreMoneyPositive: check(
    "fl_corporate_actions_pre_money_positive",
    sql`${table.pre_money} > 0`,
  ),
  flCorporateActionsRoundSizeNonNegative: check(
    "fl_corporate_actions_round_size_non_negative",
    sql`${table.round_size} >= 0`,
  ),
  idxFlCorporateActionsWorkspaceId: index("idx_fl_corporate_actions_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
  idxFlCorporateActionsAssetIdActionDate: index("idx_fl_corporate_actions_asset_id_action_date")
    .using("btree", table.asset_id.asc().nullsLast().op("uuid_ops"), table.action_date.asc().nullsLast()),
}));

// 13. fl_ownership_changes — one row per position whose stake a corporate action changes.
// Percentages are percent points (12.5 = 12.5%), matching shareholding_pct.
export const flOwnershipChanges = pgTable("fl_ownership_changes", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  corporate_action_id: uuid().notNull(),
  position_id: uuid().notNull(),
  pct_before: numeric({ precision: 12, scale: 8 }).notNull(),
  follow_on_amount: numeric({ precision: 38, scale: 8 }).default("0").notNull(),
  pct_after: numeric({ precision: 12, scale: 8 }).notNull(),
  pct_override: numeric({ precision: 12, scale: 8 }),
  override_remark: text(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  flOwnershipChangesActionFkey: foreignKey({
    columns: [table.corporate_action_id],
    foreignColumns: [flCorporateActions.id],
    name: "fl_ownership_changes_corporate_action_id_fkey",
  }).onDelete("cascade"),
  flOwnershipChangesPositionFkey: foreignKey({
    columns: [table.position_id],
    foreignColumns: [flPositions.id],
    name: "fl_ownership_changes_position_id_fkey",
  }).onDelete("cascade"),
  flOwnershipChangesActionPositionUniq: unique("fl_ownership_changes_action_position_key")
    .on(table.corporate_action_id, table.position_id),
  flOwnershipChangesPreRoundPctRange: check(
    "fl_ownership_changes_pct_before_range",
    sql`${table.pct_before} >= 0 AND ${table.pct_before} <= 100`,
  ),
  flOwnershipChangesAmountNonNegative: check(
    "fl_ownership_changes_amount_non_negative",
    sql`${table.follow_on_amount} >= 0`,
  ),
  flOwnershipChangesOverridePctRange: check(
    "fl_ownership_changes_pct_override_range",
    sql`${table.pct_override} IS NULL OR (${table.pct_override} >= 0 AND ${table.pct_override} <= 100)`,
  ),
  idxFlFundingRoundParticipationsFundingRoundId: index("idx_fl_ownership_changes_corporate_action_id")
    .using("btree", table.corporate_action_id.asc().nullsLast().op("uuid_ops")),
  idxFlFundingRoundParticipationsPositionId: index("idx_fl_ownership_changes_position_id")
    .using("btree", table.position_id.asc().nullsLast().op("uuid_ops")),
}));

// ============================================================================
// Insights & Versions
// ============================================================================

export const insights = pgTable(
  "insights",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    kind: text().$type<"document" | "report">().default("document").notNull(),
    is_featured: boolean().default(false).notNull(),
    created_by: uuid().references(() => users.id, { onDelete: "set null" }),
    updated_by: uuid().references(() => users.id, { onDelete: "set null" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    archived_at: timestamp({ withTimezone: true, mode: "string" }),
    // The bound sector agent's registry key (MB-546); null = general CoPilot.
    // No FK: the registry is code (src/lib/agents/sector/registry.ts).
    agent_key: text(),
    // The template the insight was created from. SET NULL keeps the insight
    // when the template is purged; a soft-deleted template keeps the id.
    source_template_id: uuid().references(() => insightTemplates.id, {
      onDelete: "set null",
    }),
  },
  (table) => {
    return {
      idxInsightsWorkspaceId: index("idx_insights_workspace_id").using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxInsightsWorkspaceSourceTemplate: index(
        "idx_insights_workspace_source_template",
      ).using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
        table.source_template_id.asc().nullsLast().op("uuid_ops"),
      ),
      uqInsightsWorkspaceFeatured: uniqueIndex(
        "uq_insights_workspace_featured",
      )
        .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops"))
        .where(sql`is_featured = true and archived_at is null`),
      insightsKindChk: check(
        "chk_insights_kind",
        sql`kind IN ('document', 'report')`,
      ),
    };
  },
);

export const insightVersions = pgTable(
  "insight_versions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    insight_id: uuid()
      .notNull()
      .references(() => insights.id, { onDelete: "cascade" }),
    version_no: integer().notNull(),
    // The complete document. Rendered inside a sandboxed iframe, never injected
    // into the app origin — which is why it is stored exactly as authored.
    html: text().notNull(),
    // Plain text, not a pg enum: seed | copilot_create | upload |
    // copilot_edit | rollback | duplicate | routine | workforce
    trigger: text().notNull(),
    label: text(),
    created_by: uuid().references(() => users.id, { onDelete: "set null" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    // The workforce run that published this version (trigger routine or
    // workforce). SET NULL keeps the version when the run row is deleted.
    source_run_id: uuid().references(() => aiWorkforceQueue.id, {
      onDelete: "set null",
    }),
    // sha256 of the whitespace-normalised HTML (see insights/contentHash).
    // Null on rows written before MB-559; a null hash never compares equal.
    content_hash: text(),
    // A scheduled refresh that changed nothing still records a version, so
    // every run appears in the history; this marks it and suppresses the
    // refresh notification.
    is_unchanged: boolean().default(false).notNull(),
    // The sector agent that produced this version, stamped at write time so a
    // rebind never rewrites history. Null when no sector agent produced it.
    agent_key: text(),
  },
  (table) => {
    return {
      idxInsightVersionsSourceRunId: index("idx_insight_versions_source_run_id")
        .using("btree", table.source_run_id.asc().nullsLast().op("uuid_ops"))
        .where(sql`source_run_id IS NOT NULL`),
      // One published version per refresh run, so a WDK retry landing between
      // publish and markSucceeded can't publish twice. Partial because a
      // non-refresh workforce run stamps every per-edit version with its id.
      uqInsightVersionsRoutineSourceRunId: uniqueIndex(
        "uq_insight_versions_routine_source_run_id",
      )
        .using("btree", table.source_run_id.asc().nullsLast().op("uuid_ops"))
        .where(sql`source_run_id IS NOT NULL AND trigger = 'routine'`),
      uqInsightVersionsInsightIdVersionNo: unique(
        "uq_insight_versions_insight_id_version_no",
      ).on(table.insight_id, table.version_no),
      idxInsightVersionsWorkspaceInsightVersion: index(
        "idx_insight_versions_workspace_insight_version",
      ).using(
        "btree",
        table.workspace_id.asc().nullsLast().op("uuid_ops"),
        table.insight_id.asc().nullsLast().op("uuid_ops"),
        table.version_no.desc().nullsLast().op("int4_ops"),
      ),
    };
  },
);

// A refresh run's unpublished edits to its insight (MB-558). The run publishes
// the draft once, when it succeeds; a failed run leaves it behind, and
// deleting the run cascades it away.
export const insightRunDrafts = pgTable(
  "insight_run_drafts",
  {
    run_id: uuid()
      .primaryKey()
      .notNull()
      .references(() => aiWorkforceQueue.id, { onDelete: "cascade" }),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    insight_id: uuid()
      .notNull()
      .references(() => insights.id, { onDelete: "cascade" }),
    // The version the draft was seeded from; publishing compares it with the
    // current version to label a refresh that landed over a mid-run edit.
    base_version_no: integer().notNull(),
    html: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxInsightRunDraftsInsightId: index(
        "idx_insight_run_drafts_insight_id",
      ).using("btree", table.insight_id.asc().nullsLast().op("uuid_ops")),
    };
  },
);

export const insightTemplates = pgTable(
  "insight_templates",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    icon: text(),
    // The complete template document, stored as authored (like
    // insight_versions.html). Repository reads other than findById leave it
    // out so listings don't ship every template's HTML.
    html: text().notNull(),
    created_by: uuid().references(() => users.id, { onDelete: "set null" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    // Soft delete: set while the template sits in Recently deleted. Every read
    // except the Recently deleted listing leaves these rows out.
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table) => {
    return {
      idxInsightTemplatesWorkspaceId: index(
        "idx_insight_templates_workspace_id",
      ).using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
    };
  },
);

// A workspace's deal pipeline stages, in `position` order. `key` is the
// permanent identity stored in companies.pipeline_stage (L0–L5 for the six
// original stages, `stg-<hex>` for added ones); `code` ("L0", "L6", ...) and
// `name` are what users see and edit. Deleting a stage soft-deletes it so
// dropped deals and stage history can still name it. Every workspace is seeded
// with the six defaults by a trigger on `workspaces` insert.
export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text().notNull(),
    code: text().notNull(),
    name: text().notNull(),
    description: text().default("").notNull(),
    position: integer().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table) => {
    return {
      uqPipelineStagesWorkspaceKey: uniqueIndex(
        "uq_pipeline_stages_workspace_key",
      ).on(table.workspace_id, table.key),
      idxPipelineStagesWorkspacePosition: index(
        "idx_pipeline_stages_workspace_position",
      ).on(table.workspace_id, table.position),
    };
  },
);

/**
 * The CoPilot's long-term memory (mem0), stored in our own Postgres with
 * pgvector instead of a mem0-provisioned database — see
 * `drizzle/migrations/*_user_memories.sql` and `src/lib/memory/`.
 *
 * Scoped to the USER. What the CoPilot learns about someone is about the
 * person, so it follows them into every workspace they belong to.
 * `workspace_id` is provenance only — where the memory was formed — and is
 * never part of a read or delete predicate, which is why it is nullable and
 * `SET NULL` rather than `CASCADE`.
 *
 * `payload` is mem0's own record; `memory` and `user_id` are denormalized out
 * of it so the Profile listing and the scoping filter hit an index.
 *
 * `collection` separates mem0's `memories` store from its internal
 * `memories_entities` link index; the UI only ever lists `memories`.
 */
export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid().primaryKey().notNull(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Provenance only — never filtered on. */
    workspace_id: uuid().references(() => workspaces.id, { onDelete: "set null" }),
    collection: text().default("memories").notNull(),
    memory: text().notNull(),
    // Titan Embed Text v2, the same model `rss.item_chunks` uses.
    embedding: vector({ dimensions: 1024 }).notNull(),
    payload: jsonb().default({}).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxUserMemoriesScope: index("idx_user_memories_scope").using(
        "btree",
        table.user_id.asc().nullsLast().op("uuid_ops"),
        table.collection.asc().nullsLast().op("text_ops"),
        table.created_at.desc().nullsLast().op("timestamptz_ops"),
      ),
    };
  },
);

/**
 * Personal to-dos behind Profile → "Needs your attention" and the sidebar
 * tasks button. Private to `user_id` within `workspace_id`.
 *
 * `remind_at` is optional; once it passes, the `/api/cron/task-reminders`
 * sweep emails the owner and stamps `reminder_sent_at` so it fires only once.
 * Rescheduling clears the stamp.
 */
export const userTasks = pgTable(
  "user_tasks",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    remind_at: timestamp({ withTimezone: true, mode: "string" }),
    reminder_sent_at: timestamp({ withTimezone: true, mode: "string" }),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxUserTasksOwner: index("idx_user_tasks_owner").on(
        table.workspace_id,
        table.user_id,
        table.completed_at,
        table.created_at,
      ),
      idxUserTasksDueReminders: index("idx_user_tasks_due_reminders")
        .on(table.workspace_id, table.remind_at)
        .where(
          sql`completed_at IS NULL AND reminder_sent_at IS NULL AND remind_at IS NOT NULL`,
        ),
    };
  },
);
