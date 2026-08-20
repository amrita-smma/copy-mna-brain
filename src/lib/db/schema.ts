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
  varchar,
  boolean,
  date,
  pgEnum,
  primaryKey,
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
export const dealType = pgEnum("deal_type", ["majority", "minority"]);
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
]);
export const l1Result = pgEnum("l1_result", ["pass", "fail", "inconclusive"]);
export const pipelineStage = pgEnum("pipeline_stage", [
  "market_screening",
  // Companies auto-created from email attachments, pending triage into L0.
  "unreviewed",
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  // Companies auto-created as one side of a relationship-graph edge. Not part
  // of the L0–L5 deal pipeline; surfaced in its own Master Data section.
  "discovered",
]);
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
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => {
    return {
      workspacesSlugKey: unique("workspaces_slug_key").on(table.slug),
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
    pipeline_stage: pipelineStage().default("L0").notNull(),
    remarks: text(),
    thesis_content: text(),
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
    workspace_id: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => {
    return {
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
        table.pipeline_stage.asc().nullsLast().op("enum_ops"),
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
  },
  (table) => {
    return {
      idxUsersEmail: index("idx_users_email").using(
        "btree",
        table.email.asc().nullsLast().op("text_ops"),
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
// `decided_by` is implicit (always the row's triggered_by_user_id — only the
// task creator can decide, enforced at the API layer).
export type HumanDecision = {
  tool_call_id: string;
  tool_name: string;
  decision: "approve" | "edit" | "reject";
  edited_args?: Record<string, unknown>;
  rejection_message?: string;
  decided_at: string;
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
  },
  (table) => {
    return {
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

// --- Fund Management (Confluence 2641362965) ---------------------------
// Funds the firm manages, the assets each fund holds, their transaction
// ledgers and valuation history, and fund-level performance rollups.

export const fundStatus = pgEnum("fund_status", ["investing", "harvesting"]);

export const assetType = pgEnum("asset_type", [
  "direct_investment",
  "cash",
  "fund_of_funds",
]);

export const assetStatus = pgEnum("asset_status", [
  "active",
  "exiting",
  "exited",
]);

export const transactionType = pgEnum("transaction_type", [
  "contribution",
  "divestment",
  "distribution",
  "interest_income",
  "return_of_capital",
  "other",
]);

export const valuationMethod = pgEnum("valuation_method", [
  "at_cost",
  "fundraise_round",
  "secondary_sale",
  "stock_market_price",
  "comparables",
  "capital_account_statement",
  "other",
]);

// The fund vehicle. `called_amount`, `fmv_amount`, `realized_amount`, `dpi`,
// `tvpi`, and `irr` are derived rollups normalized into `base_currency` —
// read-only, background-job-refreshed, and can lag the ledger between a
// change and the next `FundMetricsService` run (`metrics_computed_at`
// records staleness). Always gross; Net is only ever computed per-asset.
export const funds = pgTable("funds", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id),
  name: text().notNull(),
  description: text(),
  vintage_year: integer(),
  commitment_size_amount: numeric({ mode: "number" }),
  status: fundStatus().default("investing").notNull(),
  base_currency: text().default("USD").notNull(),
  called_amount: numeric({ mode: "number" }),
  fmv_amount: numeric({ mode: "number" }),
  realized_amount: numeric({ mode: "number" }),
  dpi: numeric({ mode: "number" }),
  tvpi: numeric({ mode: "number" }),
  irr: numeric({ mode: "number" }),
  metrics_computed_at: timestamp({ withTimezone: true, mode: "string" }),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  fundsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "funds_created_by_fkey",
  }).onDelete("set null"),
  fundsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "funds_updated_by_fkey",
  }).onDelete("set null"),
  idxFundsWorkspaceId: index("idx_funds_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
}));

// An LP. Backs the future by-investor view — created ahead of that view; no
// repository/service/UI reads from this table yet.
export const holdingEntities = pgTable("holding_entities", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id),
  name: text().notNull(),
  entity_type: text("investor_type"),
  invested_amount: numeric({ mode: "number" }),
  realized_amount: numeric({ mode: "number" }),
  fmv_amount: numeric({ mode: "number" }),
  dpi: numeric({ mode: "number" }),
  moic: numeric({ mode: "number" }),
  irr: numeric({ mode: "number" }),
  metrics_computed_at: timestamp({ withTimezone: true, mode: "string" }),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  holdingEntitiesCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "holding_entities_created_by_fkey",
  }).onDelete("set null"),
  holdingEntitiesUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "holding_entities_updated_by_fkey",
  }).onDelete("set null"),
  idxHoldingEntitiesWorkspaceId: index("idx_holding_entities_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
}));

// A funding source ("source of fund") capital pool. Root table — carries its
// own workspace_id. Backs the Source of Fund combobox + the by-source view,
// and is FK-referenced by fund_investor_stakes / fund_asset_investor_stakes.
export const fundingSources = pgTable("funding_sources", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id),
  name: text().notNull(),
  invested_amount: numeric({ mode: "number" }),
  realized_amount: numeric({ mode: "number" }),
  fmv_amount: numeric({ mode: "number" }),
  dpi: numeric({ mode: "number" }),
  moic: numeric({ mode: "number" }),
  irr: numeric({ mode: "number" }),
  metrics_computed_at: timestamp({ withTimezone: true, mode: "string" }),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  fundingSourcesCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "funding_sources_created_by_fkey",
  }).onDelete("set null"),
  fundingSourcesUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "funding_sources_updated_by_fkey",
  }).onDelete("set null"),
  idxFundingSourcesWorkspaceId: index("idx_funding_sources_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
}));

// `type_details` holds attributes specific to each `asset_type` — for
// `direct_investment`, `instrumentType` further distinguishes equity, an
// obligation (loan/note), or publicly traded shares.
export type DirectInvestmentDetails = {
  instrumentType?: "equity" | "obligation" | "shares";
  dealType?: string;
  entryEV?: number;
  holdYrs?: number;
  shareClass?: string;
  revenue?: number;
  ebitda?: number;
  noteType?: string;
  issuer?: string;
  coupon?: number;
  principal?: number;
  exchange?: string;
  ticker?: string;
  sharesOutstanding?: number;
  marketCapUsdBn?: number;
  pricePerShare?: string;
  // Editable in the Fund Management UI's Legal tab but with no dedicated
  // fund_assets column — kept here since type_details is the flexible
  // per-asset-type attribute bag.
  investingEntity?: string;
  reportDate?: string;
  prefReturnRatePct?: number;
  // Cross-references into the source workbook's master tabs (Structure /
  // Appendix), populated by the portfolio seed: `sourceRef` is the Appendix
  // "Invt ID" (e.g. "S017"); `vintageYear` its vintage year.
  sourceRef?: string;
  vintageYear?: number;
  /** STARTECH (etc.) workbook sheet/tab code, e.g. "GOTO" — used to re-match uploads. */
  sheetCode?: string;
};
export type CashDetails = { type?: string; institution?: string; yieldPct?: number };
export type FundOfFundsDetails = {
  targetFundName?: string;
  fundManagerName?: string;
  fundLifeYears?: number;
  holdYrs?: number;
  investingEntity?: string;
  reportDate?: string;
  dealType?: string;
  sourceRef?: string;
  vintageYear?: number;
  /** STARTECH (etc.) workbook sheet/tab code, e.g. "GOTO" — used to re-match uploads. */
  sheetCode?: string;
};
export type AssetTypeDetails =
  | DirectInvestmentDetails
  | CashDetails
  | FundOfFundsDetails;

// The asset — a company, cash reserve, loan, or fund interest a fund holds.
// No FK to `companies` (§2 design principle 1): keeps fund reporting
// independent of pipeline lifecycle events. `share_count`, `gross_moic`,
// `gross_irr`, `dpi`, `invested_capital_amount`, and `net_distribution_amount`
// are derived rollups aggregated from `fundAssetTransactions`, normalized into
// `report_currency` (share counts keep native units) — read-only, see `funds`
// above for the same staleness caveat.
export const fundAssets = pgTable("fund_assets", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  workspace_id: uuid().notNull().references(() => workspaces.id),
  asset_type: assetType().notNull(),
  asset_name: text(),
  legal_name: text(),
  // Latin-alphabet rendering of `asset_name` for investments recorded under a
  // non-English name (e.g. 株式会社ABC). Optional; when present the UI shows it
  // in brackets after the asset name.
  english_name: text(),
  country: text(),
  funding_source: text(),
  investment_type: text(),
  entry_date: date(),
  maturity_date: date(),
  commitment_amount: numeric({ mode: "number" }),
  stake_pct: numeric({ mode: "number" }),
  sector: text(),
  sub_sector: text(),
  investment_currency: text().default("USD"),
  report_currency: text().default("USD"),
  investment_description: text(),
  key_rights: text(),
  subscription_fee_amount: numeric({ mode: "number" }),
  mgmt_fee_rate_pct: numeric({ mode: "number" }),
  carry_rate_pct: numeric({ mode: "number" }),
  legal_fees_amount: numeric({ mode: "number" }),
  type_details: jsonb().$type<AssetTypeDetails>().default({}),
  status: assetStatus().default("active").notNull(),
  current_price_per_share: numeric({ mode: "number" }),
  share_count: numeric({ mode: "number" }),
  gross_moic: numeric({ mode: "number" }),
  gross_irr: numeric({ mode: "number" }),
  dpi: numeric({ mode: "number" }),
  invested_capital_amount: numeric({ mode: "number" }),
  net_distribution_amount: numeric({ mode: "number" }),
  fmv_amount: numeric({ mode: "number" }),
  is_manually_overridden: boolean().default(false).notNull(),
  metrics_computed_at: timestamp({ withTimezone: true, mode: "string" }),
  // AI Opinion: a firm BUY/HOLD/SELL verdict + ≤50-word rationale produced
  // by an AI Workforce run, surfaced as the right-most Asset table column.
  // `ai_opinion_status` tracks the in-flight run lifecycle
  // ('processing' | 'completed' | 'failed').
  // `ai_opinion_confidence` is high|medium|low (clamped by server-side
  // data sufficiency); `ai_opinion_data_gaps` lists sparse-data reasons.
  ai_opinion_verdict: text(),
  ai_opinion_summary: text(),
  ai_opinion_status: text(),
  ai_opinion_updated_at: timestamp({ withTimezone: true, mode: "string" }),
  ai_opinion_confidence: text(),
  ai_opinion_data_gaps: text(),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  fundAssetsCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fund_assets_created_by_fkey",
  }).onDelete("set null"),
  fundAssetsUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fund_assets_updated_by_fkey",
  }).onDelete("set null"),
  idxFundAssetsWorkspaceId: index("idx_fund_assets_workspace_id")
    .using("btree", table.workspace_id.asc().nullsLast().op("uuid_ops")),
}));

// An LP's commitment-based stake in a fund. Funds are not unitized — there
// is no per-unit NAV, so this table has no `share_count`; an LP's fractional
// ownership is derived as `commitment_amount / SUM(commitment_amount)`
// across every stake row for that fund, not stored. Contrast with
// `fundAssetInvestorStakes.share_count`, a real count (§5.6).
//
// `commitment_amount` and `invested_amount` are tracked separately, per PE
// convention: commitment is what an LP has pledged to the fund, invested is
// what's actually been called/drawn down so far — they diverge over the
// fund's life. Each gets its own currency column (not a single shared
// `currency`) since the two can, in principle, be denominated differently.
export const fundHoldingEntityStakes = pgTable("fund_investor_stakes", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  fund_id: uuid().notNull(),
  // holding_entity_id and funding_source_id are nullable: a stake belongs to a fund
  // (required) but the entity and/or funding source are optional (relaxed from
  // the base's NOT NULL by 20260709000000_relax_fund_investor_stake_nulls).
  holding_entity_id: uuid(),
  funding_source_id: uuid(),
  commitment_amount: numeric({ mode: "number" }),
  commitment_amount_currency: text().default("USD"),
  invested_amount: numeric({ mode: "number" }),
  invested_amount_currency: text().default("USD"),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  fundInvestorStakesFundFkey: foreignKey({
    columns: [table.fund_id],
    foreignColumns: [funds.id],
    name: "fund_investor_stakes_fund_id_fkey",
  }).onDelete("cascade"),
  fundInvestorStakesHoldingEntityFkey: foreignKey({
    columns: [table.holding_entity_id],
    foreignColumns: [holdingEntities.id],
    name: "fund_investor_stakes_holding_entity_id_fkey",
  }).onDelete("cascade"),
  fundInvestorStakesFundingSourceFkey: foreignKey({
    columns: [table.funding_source_id],
    foreignColumns: [fundingSources.id],
    name: "fund_investor_stakes_funding_source_id_fkey",
  }).onDelete("cascade"),
  fundInvestorStakesUniq: unique("fund_investor_stakes_fund_investor_uniq")
    .on(table.fund_id, table.holding_entity_id, table.funding_source_id),
  // No separate single-column index on fund_id: the composite unique index
  // above already serves fund_id-only lookups via leftmost-prefix matching.
  fundInvestorStakesCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fund_investor_stakes_created_by_fkey",
  }).onDelete("set null"),
  fundInvestorStakesUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fund_investor_stakes_updated_by_fkey",
  }).onDelete("set null"),
}));

// The ledger — every cash flow into or out of an asset. `share_count` here
// is a single transaction's delta, not a running total — see
// `fundAssets.share_count` for the cumulative figure of the same name. No
// own `workspace_id` — child of `fundAssets` via the NOT NULL
// `fund_asset_id` below; scope via a join/subquery through the parent.
export const fundAssetTransactions = pgTable("fund_asset_transactions", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  fund_asset_id: uuid().notNull(),
  fund_id: uuid(),
  holding_entity_id: uuid(),
  funding_source_id: uuid(),
  txn_date: date().notNull(),
  txn_type: transactionType().notNull(),
  sub_type_label: text(),
  price_per_share: numeric({ mode: "number" }),
  share_count: numeric({ mode: "number" }),
  value_amount: numeric({ mode: "number" }),
  txn_currency: text(),
  fx_rate: numeric({ mode: "number" }),
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
  fundAssetTxnFkey: foreignKey({
    columns: [table.fund_asset_id],
    foreignColumns: [fundAssets.id],
    name: "fund_asset_transactions_fund_asset_id_fkey",
  }).onDelete("cascade"),
  fundAssetTxnFundFkey: foreignKey({
    columns: [table.fund_id],
    foreignColumns: [funds.id],
    name: "fund_asset_transactions_fund_id_fkey",
  }).onDelete("set null"),
  fundAssetTxnHoldingEntityFkey: foreignKey({
    columns: [table.holding_entity_id],
    foreignColumns: [holdingEntities.id],
    name: "fund_asset_transactions_holding_entity_id_fkey",
  }).onDelete("set null"),
  fundAssetTxnFundingSourceFkey: foreignKey({
    columns: [table.funding_source_id],
    foreignColumns: [fundingSources.id],
    name: "fund_asset_transactions_funding_source_id_fkey",
  }).onDelete("set null"),
  fundAssetTxnCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fund_asset_transactions_created_by_fkey",
  }).onDelete("set null"),
  fundAssetTxnUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fund_asset_transactions_updated_by_fkey",
  }).onDelete("set null"),
  idxFundAssetTxnAsset: index("idx_fund_asset_transactions_fund_asset_id")
    .using("btree", table.fund_asset_id.asc().nullsLast().op("uuid_ops")),
}));

// A snapshot of an asset's value and derived metrics as of a specific date.
// `currency` is captured per row, not inherited from the asset, since a
// valuation source (e.g. a capital account statement) can report in a
// different currency than the asset's usual `investment_currency`. No own
// `workspace_id` — child of `fundAssets` via the NOT NULL `fund_asset_id`
// below; scope via a join/subquery through the parent.
export const fundAssetValuations = pgTable("fund_asset_valuations", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  fund_asset_id: uuid().notNull(),
  as_of_date: date().notNull(),
  period_label: text(),
  valuation_method: valuationMethod(),
  currency: text().default("USD"),
  market_value_amount: numeric({ mode: "number" }),
  price_per_share: numeric({ mode: "number" }),
  shares_outstanding: numeric({ mode: "number" }),
  shareholding_pct: numeric({ mode: "number" }),
  invested_capital_cum_amount: numeric({ mode: "number" }),
  net_distribution_amount: numeric({ mode: "number" }),
  gross_moic: numeric({ mode: "number" }),
  dpi: numeric({ mode: "number" }),
  gross_xirr: numeric({ mode: "number" }),
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
  fundAssetValuationFkey: foreignKey({
    columns: [table.fund_asset_id],
    foreignColumns: [fundAssets.id],
    name: "fund_asset_valuations_fund_asset_id_fkey",
  }).onDelete("cascade"),
  fundAssetValuationUniq: unique("fund_asset_valuations_asset_date_uniq")
    .on(table.fund_asset_id, table.as_of_date),
  // No separate single-column index on fund_asset_id: the composite unique
  // index above already serves fund_asset_id-only lookups (leftmost-prefix).
  fundAssetValuationCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fund_asset_valuations_created_by_fkey",
  }).onDelete("set null"),
  fundAssetValuationUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fund_asset_valuations_updated_by_fkey",
  }).onDelete("set null"),
}));

// An investor's direct co-investment in one specific asset, bypassing the
// fund's own commitment structure — unlike `fundInvestorStakes`, this one
// has a real `share_count` (§5.6).
export const fundAssetHoldingEntityStakes = pgTable("fund_asset_investor_stakes", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  fund_asset_id: uuid().notNull(),
  holding_entity_id: uuid().notNull(),
  funding_source_id: uuid().notNull(),
  commitment_amount: numeric({ mode: "number" }),
  currency: text().default("USD"),
  share_count: numeric({ mode: "number" }),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  fundAssetInvestorStakesAssetFkey: foreignKey({
    columns: [table.fund_asset_id],
    foreignColumns: [fundAssets.id],
    name: "fund_asset_investor_stakes_fund_asset_id_fkey",
  }).onDelete("cascade"),
  fundAssetInvestorStakesHoldingEntityFkey: foreignKey({
    columns: [table.holding_entity_id],
    foreignColumns: [holdingEntities.id],
    name: "fund_asset_investor_stakes_holding_entity_id_fkey",
  }).onDelete("cascade"),
  fundAssetInvestorStakesFundingSourceFkey: foreignKey({
    columns: [table.funding_source_id],
    foreignColumns: [fundingSources.id],
    name: "fund_asset_investor_stakes_funding_source_id_fkey",
  }).onDelete("cascade"),
  fundAssetInvestorStakesUniq: unique(
    "fund_asset_investor_stakes_asset_investor_uniq",
  ).on(table.fund_asset_id, table.holding_entity_id, table.funding_source_id),
  // No separate single-column index on fund_asset_id: the composite unique
  // index above already serves fund_asset_id-only lookups (leftmost-prefix).
  fundAssetInvestorStakesCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fund_asset_investor_stakes_created_by_fkey",
  }).onDelete("set null"),
  fundAssetInvestorStakesUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fund_asset_investor_stakes_updated_by_fkey",
  }).onDelete("set null"),
}));

// Fund-level history — the same time-series shape as `fundAssetValuations`,
// aggregated to the fund: committed, called, fair market value, realized
// value, and return metrics as of a given date.
export const fundValuations = pgTable("fund_valuations", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  fund_id: uuid().notNull(),
  as_of_date: date().notNull(),
  period_label: text(),
  currency: text().default("USD"),
  committed_amount: numeric({ mode: "number" }),
  called_amount: numeric({ mode: "number" }),
  fmv_amount: numeric({ mode: "number" }),
  realized_amount: numeric({ mode: "number" }),
  gross_moic: numeric({ mode: "number" }),
  gross_irr: numeric({ mode: "number" }),
  dpi: numeric({ mode: "number" }),
  created_by: uuid(),
  updated_by: uuid(),
  created_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
}, (table) => ({
  fundValuationFkey: foreignKey({
    columns: [table.fund_id],
    foreignColumns: [funds.id],
    name: "fund_valuations_fund_id_fkey",
  }).onDelete("cascade"),
  fundValuationUniq: unique("fund_valuations_fund_date_uniq")
    .on(table.fund_id, table.as_of_date),
  fundValuationCreatedByFkey: foreignKey({
    columns: [table.created_by],
    foreignColumns: [users.id],
    name: "fund_valuations_created_by_fkey",
  }).onDelete("set null"),
  fundValuationUpdatedByFkey: foreignKey({
    columns: [table.updated_by],
    foreignColumns: [users.id],
    name: "fund_valuations_updated_by_fkey",
  }).onDelete("set null"),
}));
