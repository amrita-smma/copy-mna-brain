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
  "vault_export",
  "vault_archive",
  "vault_parse",
  "crm_llm_submit",
  "crm_llm_fetch",
  "crm_domain_classify",
  "crm_ingest",
]);
export const l1Result = pgEnum("l1_result", ["pass", "fail", "inconclusive"]);
export const pipelineStage = pgEnum("pipeline_stage", [
  "market_screening",
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
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

export const pendingMutationStatus = pgEnum("pending_mutation_status", [
  "pending",
  "approved",
  "rejected",
  "timed_out",
]);

export const agentRunEventKind = pgEnum("agent_run_event_kind", [
  "assistant_message",
  "tool_call",
  "tool_result",
  "subagent_dispatch",
  "mutation_proposed",
  "mutation_resolved",
  "checkpoint_saved",
  "checkpoint_loaded",
  "node_update",
  "token_chunk",
  "error",
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
    timeout_seconds: integer().default(240).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    started_at: timestamp({ withTimezone: true, mode: "string" }),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
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
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
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

export const companyCriterias = pgTable(
  "company_criterias",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    company_id: uuid().notNull(),
    criteria_id: uuid().notNull(),
    result: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxCompanyCriteriasCompanyId: index(
        "idx_company_criterias_company_id",
      ).using("btree", table.company_id.asc().nullsLast().op("uuid_ops")),
      idxCompanyCriteriasCriteriaId: index(
        "idx_company_criterias_criteria_id",
      ).using("btree", table.criteria_id.asc().nullsLast().op("uuid_ops")),
      companyCriteriasCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "company_criterias_company_id_fkey",
      }).onDelete("cascade"),
      companyCriteriasCriteriaIdFkey: foreignKey({
        columns: [table.criteria_id],
        foreignColumns: [criterias.id],
        name: "company_criterias_criteria_id_fkey",
      }).onDelete("cascade"),
      companyCriteriasCompanyIdCriteriaIdKey: unique(
        "company_criterias_company_id_criteria_id_key",
      ).on(table.company_id, table.criteria_id),
      allowDeleteAccessOnCompanyCriterias: pgPolicy(
        "Allow delete access on company_criterias",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnCompanyCriterias: pgPolicy(
        "Allow update access on company_criterias",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnCompanyCriterias: pgPolicy(
        "Allow insert access on company_criterias",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnCompanyCriterias: pgPolicy(
        "Allow read access on company_criterias",
        { as: "permissive", for: "select", to: ["public"] },
      ),
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
    promoted_reasons: text(),
  },
  (table) => {
    return {
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
      idxCompaniesTarget: index("idx_companies_target").using(
        "btree",
        table.target.asc().nullsLast().op("text_ops"),
      ),
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

export const pastAcquisitions = pgTable(
  "past_acquisitions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    no: text(),
    project_name: text(),
    project_type: text(),
    description: text(),
    target_co_partner: text(),
    seller: text(),
    target_co_company_type: text(),
    prioritization: text(),
    source: text(),
    type_of_source: text(),
    country: text(),
    sector: text(),
    ev_100_pct_usd_m: text(),
    equity_value: text(),
    estimated_debt_usd_m: text(),
    fcf_conv: text(),
    investment_value: text(),
    stake: text(),
    revenue_usd_m: text(),
    ebitda_usd_m: text(),
    net_income_usd_m: text(),
    ebitda_margin_pct: text(),
    nim_pct: text(),
    internal_stage: text(),
    status: text(),
    internal_source: text(),
    name_of_advisors: text(),
    year: text(),
    l0_date: text(),
    reason_to_drop: text(),
    on_hold_reason: text(),
    pass_l0_screening: text(),
    main_products: text(),
    company_website: text(),
    fit_with_priority_product_groups: text(),
    details_on_product_fit: text(),
    comments: text(),
    revenue_2021_usd_m: text(),
    revenue_2022_usd_m: text(),
    revenue_2023_usd_m: text(),
    revenue_2024_usd_m: text(),
    ebitda_2021_usd_m: text(),
    ebitda_2022_usd_m: text(),
    ebitda_2023_usd_m: text(),
    ebitda_2024_usd_m: text(),
    ev_2024: text(),
    pct_revenue_from_priority_segments: text(),
    geography_breakdown_of_revenue: text(),
    cagr_2021_2022: text(),
    cagr_2022_2023: text(),
    cagr_2023_2024: text(),
    ebitda_margin_2021: text(),
    ebitda_margin_2022: text(),
    ebitda_margin_2023: text(),
    ebitda_margin_2024: text(),
    revenue_cagr_l3y: text(),
    revenue_drop_count: text(),
    assumption: text(),
    vision_alignment_25pct_revenue: text(),
    priority_geography_50pct_revenue: text(),
    ev_value_under_1b: text(),
    revenue_stability_no_consecutive_drop: text(),
    ebitda_over_10pct_l3y: text(),
    pass_all_5_l1_criteria: text(),
    willingness_to_sell: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    notes: text(),
  },
  (table) => {
    return {
      idxPastAcquisitionsCountry: index("idx_past_acquisitions_country").using(
        "btree",
        table.country.asc().nullsLast().op("text_ops"),
      ),
      idxPastAcquisitionsInternalStage: index(
        "idx_past_acquisitions_internal_stage",
      ).using("btree", table.internal_stage.asc().nullsLast().op("text_ops")),
      idxPastAcquisitionsProjectName: index(
        "idx_past_acquisitions_project_name",
      ).using("btree", table.project_name.asc().nullsLast().op("text_ops")),
      idxPastAcquisitionsSector: index("idx_past_acquisitions_sector").using(
        "btree",
        table.sector.asc().nullsLast().op("text_ops"),
      ),
      idxPastAcquisitionsStatus: index("idx_past_acquisitions_status").using(
        "btree",
        table.status.asc().nullsLast().op("text_ops"),
      ),
      idxPastAcquisitionsYear: index("idx_past_acquisitions_year").using(
        "btree",
        table.year.asc().nullsLast().op("text_ops"),
      ),
      allowDeleteAccessOnPastAcquisitions: pgPolicy(
        "Allow delete access on past_acquisitions",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnPastAcquisitions: pgPolicy(
        "Allow update access on past_acquisitions",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnPastAcquisitions: pgPolicy(
        "Allow insert access on past_acquisitions",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnPastAcquisitions: pgPolicy(
        "Allow read access on past_acquisitions",
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
    is_active: boolean().default(true),
    scan_frequency: text().default("weekly"),
    last_scan_at: timestamp({ withTimezone: true, mode: "string" }),
    next_scan_at: timestamp({ withTimezone: true, mode: "string" }),
    sources_count: integer().default(5),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
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
      screeningsCompanyIdCriteriaIdKey: unique(
        "screenings_company_id_criteria_id_key",
      ).on(table.company_id, table.criteria_id),
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

export const dealStageHistory = pgTable(
  "deal_stage_history",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid().notNull(),
    stage: text().notNull(),
    entered_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
    exited_at: timestamp({ withTimezone: true, mode: "string" }),
    duration_seconds: integer().generatedAlwaysAs(
      sql`CASE WHEN exited_at IS NOT NULL THEN EXTRACT(EPOCH FROM (exited_at - entered_at))::integer END`,
    ),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow(),
  },
  (table) => {
    return {
      idxDealStageHistoryDealId: index("idx_deal_stage_history_deal_id").using(
        "btree",
        table.deal_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxDealStageHistoryEnteredAt: index(
        "idx_deal_stage_history_entered_at",
      ).using(
        "btree",
        table.entered_at.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxDealStageHistoryStage: index("idx_deal_stage_history_stage").using(
        "btree",
        table.stage.asc().nullsLast().op("text_ops"),
      ),
      dealStageHistoryDealIdFkey: foreignKey({
        columns: [table.deal_id],
        foreignColumns: [companies.id],
        name: "deal_stage_history_deal_id_fkey",
      }).onDelete("cascade"),
      allowDeleteAccessOnDealStageHistory: pgPolicy(
        "Allow delete access on deal_stage_history",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnDealStageHistory: pgPolicy(
        "Allow update access on deal_stage_history",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnDealStageHistory: pgPolicy(
        "Allow insert access on deal_stage_history",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnDealStageHistory: pgPolicy(
        "Allow read access on deal_stage_history",
        { as: "permissive", for: "select", to: ["public"] },
      ),
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
    matched_companies: jsonb()
      .$type<{ id: string; target?: string }[]>()
      .default([]),
    file_date: date(),
    file_type: varchar().default("mom").notNull(),
  },
  (table) => {
    return {
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

export const mboxFiles = analytics.table(
  "mbox_files",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    source: text().notNull(),
    s3_bucket: text().notNull(),
    s3_key: text().notNull(),
    size_bytes: bigint({ mode: "number" }).notNull(),
    uncompressed_size_bytes: bigint({ mode: "number" }),
    custodian_email: text().notNull(),
    window_start: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    window_end: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    vault_matter_id: text(),
    vault_export_id: text(),
    mode: text().notNull(),
    job_id: uuid(),
    parse_status: text().default("pending").notNull(),
    parsed_at: timestamp({ withTimezone: true, mode: "string" }),
    parse_error: text(),
    raw_email_count: integer(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxMboxFilesSourceWindowStart: index(
        "idx_mbox_files_source_window_start",
      ).using(
        "btree",
        table.source.asc().nullsLast().op("text_ops"),
        table.window_start.asc().nullsLast().op("timestamptz_ops"),
      ),
      idxMboxFilesParseStatus: index("idx_mbox_files_parse_status").using(
        "btree",
        table.parse_status.asc().nullsLast().op("text_ops"),
      ),
      idxMboxFilesJobId: index("idx_mbox_files_job_id").using(
        "btree",
        table.job_id.asc().nullsLast().op("uuid_ops"),
      ),
      mboxFilesJobIdFkey: foreignKey({
        columns: [table.job_id],
        foreignColumns: [jobs.id],
        name: "mbox_files_job_id_fkey",
      }).onDelete("cascade"),
    };
  },
);

export const rawEmails = analytics.table(
  "raw_emails",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    file_id: uuid().notNull(),
    custodian_email: text().notNull(),
    message_id: text().notNull(),
    from_address: text(),
    from_display_name: text(),
    to_addresses: jsonb().$type<string[]>(),
    cc_addresses: jsonb().$type<string[]>(),
    subject: text(),
    body_text: text().default("").notNull(),
    sent_at: timestamp({ withTimezone: true, mode: "string" }),
    has_attachments: boolean().default(false).notNull(),
    in_reply_to: text(),
    references: text(),
    gmail_thread_id: text(),
    raw_headers: jsonb().$type<Record<string, string>>(),
    // PR #3 — CRM pipeline state
    llm_status: text().default("pending").notNull(),
    ingest_status: text().default("pending").notNull(),
    llm_enriched_at: timestamp({ withTimezone: true, mode: "string" }),
    ingested_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uqRawEmailsMessageId: uniqueIndex("uq_raw_emails_message_id").on(
      table.message_id,
    ),
    idxRawEmailsFileId: index("idx_raw_emails_file_id").using(
      "btree",
      table.file_id.asc().nullsLast().op("uuid_ops"),
    ),
    idxRawEmailsSentAt: index("idx_raw_emails_sent_at").using(
      "btree",
      table.sent_at.asc().nullsLast().op("timestamptz_ops"),
    ),
    idxRawEmailsCustodianEmail: index("idx_raw_emails_custodian_email").using(
      "btree",
      table.custodian_email.asc().nullsLast().op("text_ops"),
    ),
    idxRawEmailsLlmStatus: index("idx_raw_emails_llm_status").using(
      "btree",
      table.llm_status.asc().nullsLast().op("text_ops"),
    ),
    idxRawEmailsIngestStatus: index("idx_raw_emails_ingest_status").using(
      "btree",
      table.ingest_status.asc().nullsLast().op("text_ops"),
    ),
    rawEmailsFileIdFkey: foreignKey({
      columns: [table.file_id],
      foreignColumns: [mboxFiles.id],
      name: "raw_emails_file_id_fkey",
    }).onDelete("cascade"),
  }),
);

export const llmBatches = analytics.table(
  "llm_batches",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    anthropic_batch_id: text().notNull(),
    status: text().notNull(),
    model: text().notNull(),
    request_count: integer().notNull(),
    custom_id_map: jsonb().$type<Record<string, string>>().notNull(),
    submit_job_id: uuid(),
    fetch_job_id: uuid(),
    submitted_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    ended_at: timestamp({ withTimezone: true, mode: "string" }),
    fetched_at: timestamp({ withTimezone: true, mode: "string" }),
    error: text(),
  },
  (table) => ({
    uqLlmBatchesAnthropicBatchId: uniqueIndex(
      "uq_llm_batches_anthropic_batch_id",
    ).on(table.anthropic_batch_id),
    idxLlmBatchesStatus: index("idx_llm_batches_status").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    llmBatchesSubmitJobIdFkey: foreignKey({
      columns: [table.submit_job_id],
      foreignColumns: [jobs.id],
      name: "llm_batches_submit_job_id_fkey",
    }).onDelete("set null"),
    llmBatchesFetchJobIdFkey: foreignKey({
      columns: [table.fetch_job_id],
      foreignColumns: [jobs.id],
      name: "llm_batches_fetch_job_id_fkey",
    }).onDelete("set null"),
  }),
);

export const rawEmailEnrichments = analytics.table(
  "raw_email_enrichments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    raw_email_id: uuid().notNull(),
    candidates: jsonb(),
    domain_tag: text(),
    needs_llm: boolean().notNull(),
    body_snippet: text(),
    extracted_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    topics: jsonb().$type<string[]>(),
    people: jsonb(),
    llm_model: text(),
    llm_batch_id: uuid(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uqRawEmailEnrichmentsRawEmailId: uniqueIndex(
      "uq_raw_email_enrichments_raw_email_id",
    ).on(table.raw_email_id),
    idxRawEmailEnrichmentsNeedsLlm: index(
      "idx_raw_email_enrichments_needs_llm",
    ).using("btree", table.needs_llm.asc().nullsLast()),
    idxRawEmailEnrichmentsLlmBatchId: index(
      "idx_raw_email_enrichments_llm_batch_id",
    ).using("btree", table.llm_batch_id.asc().nullsLast().op("uuid_ops")),
    rawEmailEnrichmentsRawEmailIdFkey: foreignKey({
      columns: [table.raw_email_id],
      foreignColumns: [rawEmails.id],
      name: "raw_email_enrichments_raw_email_id_fkey",
    }).onDelete("cascade"),
    rawEmailEnrichmentsLlmBatchIdFkey: foreignKey({
      columns: [table.llm_batch_id],
      foreignColumns: [llmBatches.id],
      name: "raw_email_enrichments_llm_batch_id_fkey",
    }).onDelete("set null"),
  }),
);

export const domainClassifications = analytics.table(
  "domain_classifications",
  {
    domain: text().primaryKey().notNull(),
    name: text(),
    industry: text(),
    confidence: text().notNull(),
    source: text().notNull(),
    classified_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
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

export const userCompanyFavorites = pgTable(
  "user_company_favorites",
  {
    user_id: uuid().notNull(),
    company_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxUserCompanyFavoritesCompanyId: index(
        "idx_user_company_favorites_company_id",
      ).using("btree", table.company_id.asc().nullsLast().op("uuid_ops")),
      userCompanyFavoritesUserIdFkey: foreignKey({
        columns: [table.user_id],
        foreignColumns: [users.id],
        name: "user_company_favorites_user_id_fkey",
      }).onDelete("cascade"),
      userCompanyFavoritesCompanyIdFkey: foreignKey({
        columns: [table.company_id],
        foreignColumns: [companies.id],
        name: "user_company_favorites_company_id_fkey",
      }).onDelete("cascade"),
      userCompanyFavoritesPkey: primaryKey({
        columns: [table.user_id, table.company_id],
        name: "user_company_favorites_pkey",
      }),
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

export const correspondentCompanies = pgTable(
  "correspondent_companies",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    correspondent_id: uuid().notNull(),
    company_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uqCorrespondentCompanies: unique("uq_correspondent_companies").on(
      table.correspondent_id,
      table.company_id,
    ),
    correspondentCompaniesCorrespondentFkey: foreignKey({
      columns: [table.correspondent_id],
      foreignColumns: [correspondents.id],
      name: "correspondent_companies_correspondent_id_fkey",
    }).onDelete("cascade"),
    correspondentCompaniesCompanyFkey: foreignKey({
      columns: [table.company_id],
      foreignColumns: [companies.id],
      name: "correspondent_companies_company_id_fkey",
    }).onDelete("cascade"),
    allowReadCorrespondentCompanies: pgPolicy(
      "Allow read access on correspondent_companies",
      { as: "permissive", for: "select", to: ["public"] },
    ),
    allowInsertCorrespondentCompanies: pgPolicy(
      "Allow insert access on correspondent_companies",
      { as: "permissive", for: "insert", to: ["public"] },
    ),
    allowUpdateCorrespondentCompanies: pgPolicy(
      "Allow update access on correspondent_companies",
      { as: "permissive", for: "update", to: ["public"] },
    ),
    allowDeleteCorrespondentCompanies: pgPolicy(
      "Allow delete access on correspondent_companies",
      { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
    ),
  }),
);

export const employerNotes = pgTable(
  "employer_notes",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    employer_id: uuid().notNull(),
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
    employerNotesEmployerFkey: foreignKey({
      columns: [table.employer_id],
      foreignColumns: [employers.id],
      name: "employer_notes_employer_id_fkey",
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
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    topicsNameKey: unique("topics_name_key").on(table.name),
    topicsSlugKey: unique("topics_slug_key").on(table.slug),
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
    subject: text(),
    body_text: text(),
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
  },
  (table) => {
    return {
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

export const agentRunEvents = pgTable(
  "agent_run_events",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    run_id: uuid().notNull(),
    seq: integer().notNull(),
    kind: agentRunEventKind().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    latency_ms: integer(),
    tokens_in: integer(),
    tokens_out: integer(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      idxAgentRunEventsRun: index("idx_agent_run_events_run").using(
        "btree",
        table.run_id.asc().nullsLast().op("uuid_ops"),
        table.seq.asc().nullsLast().op("int4_ops"),
      ),
      agentRunEventsRunIdFkey: foreignKey({
        columns: [table.run_id],
        foreignColumns: [aiWorkforceQueue.id],
        name: "agent_run_events_run_id_fkey",
      }).onDelete("cascade"),
      agentRunEventsRunSeqKey: unique("agent_run_events_run_id_seq_key").on(
        table.run_id,
        table.seq,
      ),
      allowDeleteAccessOnAgentRunEvents: pgPolicy(
        "Allow delete access on agent_run_events",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnAgentRunEvents: pgPolicy(
        "Allow update access on agent_run_events",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnAgentRunEvents: pgPolicy(
        "Allow insert access on agent_run_events",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnAgentRunEvents: pgPolicy(
        "Allow read access on agent_run_events",
        { as: "permissive", for: "select", to: ["public"] },
      ),
    };
  },
);

export const pendingMutations = pgTable(
  "pending_mutations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    run_id: uuid().notNull(),
    tool_name: text().notNull(),
    proposed_diff: jsonb().$type<Record<string, unknown>>().notNull(),
    human_summary: text().notNull(),
    status: pendingMutationStatus().default("pending").notNull(),
    resolved_by: uuid(),
    resolved_at: timestamp({ withTimezone: true, mode: "string" }),
    resolution_note: text(),
    applied_result: jsonb().$type<unknown>(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    expires_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => {
    return {
      idxPendingMutationsRun: index("idx_pending_mutations_run").using(
        "btree",
        table.run_id.asc().nullsLast().op("uuid_ops"),
      ),
      idxPendingMutationsStatus: index(
        "idx_pending_mutations_status",
      ).using("btree", table.status.asc().nullsLast().op("enum_ops")),
      pendingMutationsRunIdFkey: foreignKey({
        columns: [table.run_id],
        foreignColumns: [aiWorkforceQueue.id],
        name: "pending_mutations_run_id_fkey",
      }).onDelete("cascade"),
      pendingMutationsResolvedByFkey: foreignKey({
        columns: [table.resolved_by],
        foreignColumns: [users.id],
        name: "pending_mutations_resolved_by_fkey",
      }).onDelete("set null"),
      allowDeleteAccessOnPendingMutations: pgPolicy(
        "Allow delete access on pending_mutations",
        { as: "permissive", for: "delete", to: ["public"], using: sql`true` },
      ),
      allowUpdateAccessOnPendingMutations: pgPolicy(
        "Allow update access on pending_mutations",
        { as: "permissive", for: "update", to: ["public"] },
      ),
      allowInsertAccessOnPendingMutations: pgPolicy(
        "Allow insert access on pending_mutations",
        { as: "permissive", for: "insert", to: ["public"] },
      ),
      allowReadAccessOnPendingMutations: pgPolicy(
        "Allow read access on pending_mutations",
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
    created_by: uuid().notNull(),
    updated_by: uuid(),
    created_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    archived_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table) => {
    return {
      idxRoutinesActiveDue: index("idx_routines_active_due").using(
        "btree",
        table.next_fire_at.asc().nullsLast().op("timestamptz_ops"),
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
  },
  (table) => {
    return {
      idxCopilotChatsUserActive: index("idx_copilot_chats_user_active").using(
        "btree",
        table.user_id.asc().nullsLast().op("uuid_ops"),
        table.last_active_at.desc().nullsFirst().op("timestamptz_ops"),
      ),
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
  },
  (table) => {
    return {
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
