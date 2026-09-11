import type * as schema from "@/lib/db/schema";
import type { DbClient } from "@/lib/server/db";

export type { DbClient };

// Map of public table names (as used in DB / legacy Supabase code) to their
// Drizzle schema exports.
type TableMap = {
  companies: typeof schema.companies;
  company_assignees: typeof schema.companyAssignees;
  company_logs: typeof schema.companyLogs;
  company_analyses: typeof schema.companyAnalyses;
  company_financials: typeof schema.companyFinancials;
  company_fx_adjustments: typeof schema.companyFxAdjustments;
  company_screening_derived: typeof schema.companyScreeningDerived;
  company_slides: typeof schema.companySlides;
  company_vote_sessions: typeof schema.companyVoteSessions;
  company_vote_ballots: typeof schema.companyVoteBallots;
  criterias: typeof schema.criterias;
  deal_documents: typeof schema.dealDocuments;
  deal_links: typeof schema.dealLinks;
  deal_notes: typeof schema.dealNotes;
  files: typeof schema.files;
  investment_thesis: typeof schema.investmentThesis;
  track_variables: typeof schema.trackVariables;
  inven_cache: typeof schema.invenCache;
  jobs: typeof schema.jobs;
  job_logs: typeof schema.jobLogs;
  reset_password_tokens: typeof schema.resetPasswordTokens;
  screenings: typeof schema.screenings;
  recent_files: typeof schema.recentFiles;
  users: typeof schema.users;
  ai_workforce_queue: typeof schema.aiWorkforceQueue;
  routines: typeof schema.routines;
  copilot_chats: typeof schema.copilotChats;
  api_keys: typeof schema.apiKeys;
  api_chat_conversations: typeof schema.apiChatConversations;
  alphasense_tool_calls: typeof schema.alphasenseToolCalls;
  app_settings: typeof schema.appSettings;
  feedback: typeof schema.feedback;
  user_consents: typeof schema.userConsents;
  employers: typeof schema.employers;
  employer_domains: typeof schema.employerDomains;
  employer_overrides: typeof schema.employerOverrides;
  employer_curation: typeof schema.employerCuration;
  correspondents: typeof schema.correspondents;
  correspondent_curation: typeof schema.correspondentCuration;
  employer_notes: typeof schema.employerNotes;
  topics: typeof schema.topics;
  employer_topics: typeof schema.employerTopics;
  emails: typeof schema.emails;
  email_topics: typeof schema.emailTopics;
  email_participants: typeof schema.emailParticipants;
  employer_team_members: typeof schema.employerTeamMembers;
  employer_related_companies: typeof schema.employerRelatedCompanies;
  employer_related_company_evidence: typeof schema.employerRelatedCompanyEvidence;
  workspaces: typeof schema.workspaces;
  roles: typeof schema.roles;
  user_workspaces: typeof schema.userWorkspaces;
  rss_feeds: typeof schema.rssFeeds;
  rss_items: typeof schema.rssItems;
  rss_item_chunks: typeof schema.rssItemChunks;
  rss_ingest_runs: typeof schema.rssIngestRuns;

  // Fund Ledger v2
  fl_investors: typeof schema.flInvestors;
  fl_funds: typeof schema.flFunds;
  fl_assets: typeof schema.flAssets;
  fl_funding_sources: typeof schema.flFundingSources;
  fl_positions: typeof schema.flPositions;
  fl_business_events: typeof schema.flBusinessEvents;
  fl_business_event_revisions: typeof schema.flBusinessEventRevisions;
  fl_ledger_entries: typeof schema.flLedgerEntries;
  fl_ledger_entry_funding_allocations: typeof schema.flLedgerEntryFundingAllocations;
  fl_valuations: typeof schema.flValuations;
  fl_source_records: typeof schema.flSourceRecords;
};

export type Tables<T extends keyof TableMap> = TableMap[T]["$inferSelect"];

// NOTE: Drizzle's $inferInsert narrows incorrectly under strictNullChecks: false
// (keys of nullable columns disappear). We merge it with Partial<Select> so
// every column is a valid key, while required non-null columns stay required.
export type TablesInsert<T extends keyof TableMap> =
  TableMap[T]["$inferInsert"] &
    Partial<
      Omit<TableMap[T]["$inferSelect"], keyof TableMap[T]["$inferInsert"]>
    >;

export type TablesUpdate<T extends keyof TableMap> = Partial<
  TableMap[T]["$inferSelect"]
>;

// ===== Fund Ledger v2 Repository Types =====

export interface PositionDeltaSums {
  position_id: string;
  asset_kind?: string | null;
  commitment_sum: string;
  quantity_sum: string;
  cash_sum: string;
  contributed_sum: string;
  paid_in_adjustment_sum?: string;
  valuation_delta_sum?: string;
  retained_proceeds_sum?: string;
}

export interface FlPositionNaturalKey {
  holderInvestorId?: string | null;
  holderFundId?: string | null;
  fundId?: string | null;
  assetId?: string | null;
  holderSourceOfFundId?: string | null;
}

export interface FlPositionFilters {
  fundId?: string;
  holderInvestorId?: string;
  holderFundId?: string;
  assetId?: string;
  holderSourceOfFundId?: string | null;
}

export interface FlLedgerEntryPagination {
  limit?: number;
  offset?: number;
}

export interface FlValuationTarget {
  assetId?: string | null;
  fundId?: string | null;
  positionId?: string | null;
}
