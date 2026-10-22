import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  summarizationMiddleware: vi.fn((config: unknown) => ({ __summarization: config })),
}));

vi.mock('langchain', () => ({ summarizationMiddleware: mocks.summarizationMiddleware }));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(public opts: Record<string, unknown>) {}
  },
}));
// Every tool a skill names, as a stub carrying the tool's export name.
vi.mock('@/lib/agents/analysis/tools', () => {
  const t = (name: string) => ({ name });
  return {
    SERVER_TOOLS: [],
    lookupCrm: t('lookup_crm'),
    crmInsights: t('crm_insights'),
    queryMeetingNotes: t('query_files'),
    listPipelineStages: t('list_pipeline_stages'),
    analyzeStalledDeals: t('analyze_stalled_deals'),
    queryCompanies: t('query_companies'),
    getCompanyStats: t('get_company_stats'),
    getInsight: t('get_insight'),
    proposeInsightCreate: t('propose_insight_create'),
    proposeInsightEdit: t('propose_insight_edit'),
    proposeInsightRefresh: t('propose_insight_refresh'),
    valyuSearch: t('valyu_search'),
    readRelationshipGraph: t('read_relationship_graph'),
    sendEmailTool: t('send_email'),
    searchChatHistory: t('search_chat_history'),
    lookupBot: t('lookup_bot'),
    proposeCreateBot: t('propose_create_bot'),
    updateBot: t('update_bot'),
    listRoutines: t('list_routines'),
    proposeCreateRoutine: t('propose_create_routine'),
    updateRoutine: t('update_routine'),
    deleteRoutine: t('delete_routine'),
    listTasks: t('list_tasks'),
    createTask: t('create_task'),
    updateTask: t('update_task'),
    deleteTask: t('delete_task'),
    offerOptions: t('offer_options'),
  };
});

import {
  BOT_SUMMARY_KEEP_MESSAGES,
  BOT_SUMMARY_TRIGGER_TOKENS,
  botThreadMiddleware,
  buildBotTurnOverride,
} from './threadMiddleware';
import { BOT_GUARDRAILS } from './prompt';

describe('botThreadMiddleware', () => {
  beforeEach(() => mocks.summarizationMiddleware.mockClear());

  it('summarizes past the token trigger, keeps recent messages, and is built once', () => {
    const first = botThreadMiddleware();
    const second = botThreadMiddleware();

    expect(first).toBe(second);
    const config = (first[0] as unknown as { __summarization: Record<string, unknown> }).__summarization;
    expect(config.trigger).toEqual({ tokens: BOT_SUMMARY_TRIGGER_TOKENS });
    expect(config.keep).toEqual({ messages: BOT_SUMMARY_KEEP_MESSAGES });
  });
});

describe('buildBotTurnOverride', () => {
  it("layers the bot over the graph's prompt and tools, with context editing on", () => {
    const graph = {
      getSystemPrompt: () => 'FLAVOR',
      getToolList: () => [{ name: 'query_companies' }] as never,
    };
    const middleware = [{ m: 1 }] as never;

    const override = buildBotTurnOverride(
      graph,
      { name: 'Mailer', persona_md: 'Hi' },
      middleware,
    );

    expect(override.systemPrompt.startsWith(BOT_GUARDRAILS)).toBe(true);
    expect(override.systemPrompt).toContain('FLAVOR');
    // Every bot has every skill's tools after the base ones.
    const tools = (override.toolList as { name: string }[]).map((t) => t.name);
    expect(tools.slice(0, 3)).toEqual(['query_companies', 'search_chat_history', 'offer_options']);
    expect(tools).toEqual(expect.arrayContaining(['send_email', 'lookup_bot', 'update_bot']));
    expect(override.middleware).toBe(middleware);
    expect(override.contextEditing).toBe(true);
  });
});
