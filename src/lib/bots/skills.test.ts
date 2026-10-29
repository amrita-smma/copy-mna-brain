import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/agents/analysis/tools', () => {
  const t = (name: string) => ({ name });
  return {
    lookupCrm: t('lookup_crm'),
    crmInsights: t('crm_insights'),
    queryMeetingNotes: t('query_files'),
    listPipelineStages: t('list_pipeline_stages'),
    analyzeStalledDeals: t('analyze_stalled_deals'),
    queryCompanies: t('query_companies'),
    getCompanyStats: t('get_company_stats'),
    getInsight: t('get_insight'),
    proposeInsightEdit: t('propose_insight_edit'),
    proposeInsightRefresh: t('propose_insight_refresh'),
    SERVER_TOOLS: [t('web_search'), t('web_fetch')],
    valyuSearch: t('valyu_search'),
    readPipelineOperationsGuide: { name: 'read_pipeline_operations_guide' },
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
    offerOptions: t('offer_options'),
    listTasks: t('list_tasks'),
    createTask: t('create_task'),
    updateTask: t('update_task'),
    deleteTask: t('delete_task'),
    meetingIntelligence: t('meeting_intelligence'),
  };
});

import { BOT_SKILLS, mergeBotTools } from './skills';
import { BOT_SKILL_KEYS, BOT_SKILL_META } from './types';

const names = (list: { name?: string }[]) => list.map((t) => t.name);

describe('BOT_SKILLS', () => {
  it('gives every catalogue key a guide and at least one tool', () => {
    for (const key of BOT_SKILL_KEYS) {
      expect(BOT_SKILL_META[key].guide.trim()).not.toBe('');
      expect(BOT_SKILLS[key].tools().length).toBeGreaterThan(0);
    }
  });
});

describe('mergeBotTools', () => {
  it("gives every bot the core tools and every skill's tools, after the base ones and without repeats", () => {
    const base = [{ name: 'query_companies' }, { name: 'web_search' }] as never;

    expect(names(mergeBotTools(base) as never)).toEqual([
      'query_companies',
      'web_search',
      'search_chat_history',
      'offer_options',
      'lookup_crm',
      'crm_insights',
      'query_files',
      'get_company_stats',
      'list_pipeline_stages',
      'analyze_stalled_deals',
      'get_insight',
      'propose_insight_edit',
      'propose_insight_refresh',
      'web_fetch',
      'valyu_search',
      'read_relationship_graph',
      'send_email',
      'lookup_bot',
      'propose_create_bot',
      'update_bot',
      'list_routines',
      'propose_create_routine',
      'update_routine',
      'delete_routine',
      'list_tasks',
      'create_task',
      'update_task',
      'delete_task',
      'meeting_intelligence',
    ]);
  });
});
