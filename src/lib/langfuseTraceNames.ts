/**
 * Langfuse trace names for every agent run.
 *
 * The LangChain handler names a trace after its root run, and an unnamed
 * `createAgent` graph's root run is called "LangGraph" — so without a `runName`
 * a Copilot turn, a bot-to-bot hand-off, a company card and an AI screening
 * all land in Langfuse as the same "LangGraph" row. Every `AgentGraph` caller
 * passes one of these as `runName` instead.
 *
 * Names are `<surface>.<what>`, the same shape the side calls already use
 * (`chat.effort_router`, `workforce.title`, `bots.task_summary`), so a
 * Langfuse name filter of `workforce.*` or `bots.*` selects a whole surface.
 *
 * Pure and dependency-free on purpose: `runAgent` (a WDK step module) imports it.
 */

export const TRACE_NAMES = {
  /** A user's Copilot turn in the app (`/api/chat`). */
  copilotChat: 'chat.copilot',
  /** A turn through the external chat API (`/api/v1/chat`, `/api/v1/chat/stream`). */
  apiChat: 'chat.api',
  /** Drafting memory statements from an imported assistant export. */
  memoryImport: 'chat.memory_import',
  /** The dashboard's daily pulse narration. */
  dailyPulse: 'dashboard.daily_pulse',
  /** Job: building a company card (company analysis). */
  companyAnalysisJob: 'jobs.company_analysis',
  /** Job: screening a company against the workspace's criteria. */
  aiScreeningJob: 'jobs.ai_screening',
  /** Job: discovering companies that match the investment thesis. */
  marketScreeningJob: 'jobs.market_screening',
  /** Job: matching a company to pipeline tracks. */
  trackMatchingJob: 'jobs.track_matching',
  /** Extracting structured data from an uploaded file. */
  fileProcessing: 'files.extract',
  /** Extracting a fund update's figures from its documents. */
  fundUpdateExtraction: 'fund_update.extract',
} as const;

/** How a background bot turn reached the bot (`BotTurnOrigin['kind']`). */
export type BotTurnOriginKind = 'bot_mention' | 'user_mention' | 'routine' | 'bot_reply';

const BOT_TURN_TRACE_NAMES: Record<BotTurnOriginKind, string> = {
  // Another bot @mentioned this one: the bot-to-bot hand-off.
  bot_mention: 'bots.bot_to_bot',
  // The bots this one handed work to have answered; it writes them up.
  bot_reply: 'bots.bot_to_bot_reply',
  // The user @mentioned this bot while chatting with another.
  user_mention: 'bots.user_mention',
  // The bot's own scheduled routine fired.
  routine: 'bots.routine',
};

/** The trace name for a background bot turn. */
export function botTurnTraceName(kind: BotTurnOriginKind): string {
  return BOT_TURN_TRACE_NAMES[kind];
}

/**
 * Queue `agent_name`s that name a distinct AI Workforce task. Anything else —
 * `chat_handoff`, a name typed into the queue form, the routines' `analysis` —
 * is a general-purpose run, named by how it started (see `workforceTraceName`).
 */
const WORKFORCE_TASK_TRACE_NAMES: Record<string, string> = {
  company_card: 'workforce.company_card',
  ai_screening: 'workforce.ai_screening',
  // The company dialog's "Find contacts": the company's partnership contacts.
  crm_company_contacts: 'workforce.find_partnership_contacts',
  // The CRM's "fill this contact": enrich one contact.
  crm_contact: 'workforce.crm_contact_enrichment',
  ai_opinion: 'workforce.ai_opinion',
  fund_ai_opinion: 'workforce.fund_ai_opinion',
};

/** The trace name for an AI Workforce run. */
export function workforceTraceName(run: {
  agentName: string | null | undefined;
  originRoutineId?: string | null;
  refreshInsightId?: string | null;
}): string {
  const task = run.agentName ? WORKFORCE_TASK_TRACE_NAMES[run.agentName.trim()] : undefined;
  if (task) return task;
  if (run.refreshInsightId) return 'workforce.insight_refresh';
  if (run.originRoutineId) return 'workforce.routine';
  return 'workforce.ad_hoc';
}
