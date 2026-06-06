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
  company_criterias: typeof schema.companyCriterias;
  company_financials: typeof schema.companyFinancials;
  company_fx_adjustments: typeof schema.companyFxAdjustments;
  company_screening_derived: typeof schema.companyScreeningDerived;
  company_slides: typeof schema.companySlides;
  criterias: typeof schema.criterias;
  deal_documents: typeof schema.dealDocuments;
  deal_links: typeof schema.dealLinks;
  deal_notes: typeof schema.dealNotes;
  deal_stage_history: typeof schema.dealStageHistory;
  files: typeof schema.files;
  investment_thesis: typeof schema.investmentThesis;
  inven_cache: typeof schema.invenCache;
  jobs: typeof schema.jobs;
  job_logs: typeof schema.jobLogs;
  past_acquisitions: typeof schema.pastAcquisitions;
  reset_password_tokens: typeof schema.resetPasswordTokens;
  screenings: typeof schema.screenings;
  user_company_favorites: typeof schema.userCompanyFavorites;
  users: typeof schema.users;
  ai_workforce_queue: typeof schema.aiWorkforceQueue;
  agent_run_events: typeof schema.agentRunEvents;
  pending_mutations: typeof schema.pendingMutations;
  routines: typeof schema.routines;
  copilot_chats: typeof schema.copilotChats;
  api_keys: typeof schema.apiKeys;
  api_chat_conversations: typeof schema.apiChatConversations;
  employers: typeof schema.employers;
  correspondents: typeof schema.correspondents;
  correspondent_companies: typeof schema.correspondentCompanies;
  employer_notes: typeof schema.employerNotes;
  topics: typeof schema.topics;
  employer_topics: typeof schema.employerTopics;
  emails: typeof schema.emails;
  email_topics: typeof schema.emailTopics;
  email_participants: typeof schema.emailParticipants;
  employer_team_members: typeof schema.employerTeamMembers;
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
