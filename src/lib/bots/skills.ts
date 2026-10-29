/**
 * The bot skills catalogue (RFC 02). A skill is a named set of chat tools plus
 * a short guide (`BOT_SKILL_META`, written into every bot's fixed
 * instructions). Every bot has every skill; nobody picks them. Every tool here already runs with the
 * permissions of the person chatting — tools read the workspace and user from
 * the request context, never from the bot.
 *
 * Tool lists are built lazily (`lazyToolList`) for the same import-cycle
 * reason the flavors are — see `flavors/lazyToolList.ts`.
 */
import {
  lookupCrm,
  crmInsights,
  queryMeetingNotes,
  listPipelineStages,
  analyzeStalledDeals,
  queryCompanies,
  getCompanyStats,
  getInsight,
  proposeInsightEdit,
  proposeInsightRefresh,
  SERVER_TOOLS,
  valyuSearch,
  readRelationshipGraph,
  sendEmailTool,
  searchChatHistory,
  lookupBot,
  proposeCreateBot,
  updateBot,
  listRoutines,
  proposeCreateRoutine,
  updateRoutine,
  deleteRoutine,
  offerOptions,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  meetingIntelligence,
} from '@/lib/agents/analysis/tools';
import { lazyToolList, type ToolListFactory } from '@/lib/agents/analysis/flavors/lazyToolList';
import type { ToolList } from '@/lib/agents/analysis/flavors/types';
import { BOT_SKILL_KEYS, BOT_SKILL_META, type BotSkillKey, type BotSkillMeta } from './types';

export interface BotSkill extends BotSkillMeta {
  tools: ToolListFactory;
}

export const BOT_SKILLS: Record<BotSkillKey, BotSkill> = {
  crm: {
    ...BOT_SKILL_META.crm,
    tools: lazyToolList(() => [lookupCrm, crmInsights, queryMeetingNotes]),
  },
  pipeline: {
    ...BOT_SKILL_META.pipeline,
    tools: lazyToolList(() => [queryCompanies, getCompanyStats, listPipelineStages, analyzeStalledDeals]),
  },
  insights: {
    ...BOT_SKILL_META.insights,
    // No propose_insight_create: a new insight is always built by the Workforce
    // (propose_workforce_handoff, in every bot's base tools), as in chat.
    tools: lazyToolList(() => [getInsight, proposeInsightEdit, proposeInsightRefresh]),
  },
  research: {
    ...BOT_SKILL_META.research,
    tools: lazyToolList(() => [...SERVER_TOOLS, valyuSearch]),
  },
  relationships: {
    ...BOT_SKILL_META.relationships,
    tools: lazyToolList(() => [readRelationshipGraph]),
  },
  email: {
    ...BOT_SKILL_META.email,
    tools: lazyToolList(() => [sendEmailTool]),
  },
  bot_builder: {
    ...BOT_SKILL_META.bot_builder,
    tools: lazyToolList(() => [lookupBot, proposeCreateBot, updateBot]),
  },
  routines: {
    ...BOT_SKILL_META.routines,
    // Creation goes on a card (the card supplies the browser timezone);
    // changing or deleting an existing routine applies at once.
    tools: lazyToolList(() => [listRoutines, proposeCreateRoutine, updateRoutine, deleteRoutine]),
  },
  tasks: {
    ...BOT_SKILL_META.tasks,
    // Full CRUD, applied at once: a to-do is the user's own note.
    tools: lazyToolList(() => [listTasks, createTask, updateTask, deleteTask]),
  },
  meetings: {
    ...BOT_SKILL_META.meetings,
    // Read-only, as the chatting user. Refuses (with instructions) when the
    // workspace flag is off or the user hasn't connected.
    tools: lazyToolList(() => [meetingIntelligence]),
  },
};

/**
 * Tools every bot has outside the catalogue: recall over its permanent
 * thread's stored history (older turns are summarized out of its context),
 * and option cards for asking the user to choose.
 */
export const BOT_CORE_TOOLS: ToolListFactory = lazyToolList(() => [searchChatHistory, offerOptions]);

function toolName(tool: ToolList[number]): string {
  return (tool as { name?: string }).name ?? '';
}

/**
 * The bot's tool list: the base flavour's tools, then the core bot tools, then
 * every skill's tools that are not already there. Order is stable, so the
 * prompt cache prefix (tools come first) stays warm across turns.
 */
export function mergeBotTools(baseTools: ToolList): ToolList {
  const seen = new Set(baseTools.map(toolName));
  const merged: ToolList = [...baseTools];
  const sources = [BOT_CORE_TOOLS, ...BOT_SKILL_KEYS.map((key) => BOT_SKILLS[key].tools)];
  for (const source of sources) {
    for (const tool of source()) {
      const name = toolName(tool);
      if (seen.has(name)) continue;
      seen.add(name);
      merged.push(tool);
    }
  }
  return merged;
}
