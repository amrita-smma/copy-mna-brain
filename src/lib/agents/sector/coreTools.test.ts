import { describe, it, expect, vi } from 'vitest';

// `analysis/tools` reaches the agent module through the workforce trigger,
// which imports back into `tools` — stubbing the agent breaks that cycle so the
// tool arrays are populated rather than undefined at import time (same as
// analysis/tools/index.test.ts).
vi.mock('@/lib/agents/analysis', () => ({
  getStatelessAgentGraph: vi.fn(),
  getWorkforceAgentGraphForEffort: vi.fn(),
  getAgentGraph: vi.fn(),
  createLocalAgent: vi.fn(),
  AgentGraph: vi.fn(),
}));

import {
  tools,
  chatOnlyTools,
  workforceOnlyTools,
  investmentTools,
  combinedTools,
  vcTools,
  valyuSearch,
} from '@/lib/agents/analysis/tools';
import { invenPaidDataSourceEnrichment } from '@/lib/agents/analysis/tools/inven_paid_data_source_enrichment';
import { invenPaidDataSourceSearch } from '@/lib/agents/analysis/tools/inven_paid_data_source_search';
import { financialEquityAnalysis } from '@/lib/agents/analysis/tools/financial_equity_analysis';
import { SECTOR_CHAT_CORE_TOOLS, SECTOR_WORKFORCE_CORE_TOOLS, composeSectorTools } from './coreTools';
import { MINERBA_EXTRA_TOOLS, MINERBA_TOOLS } from '@/lib/agents/minerba/tools';
import { DIKTI_EXTRA_TOOLS, DIKTI_TOOLS } from '@/lib/agents/dikti/tools';
import { BANGUN_EXTRA_TOOLS, BANGUN_TOOLS } from '@/lib/agents/bangun/tools';

const names = (list: ReadonlyArray<{ name: string }>) => list.map((t) => t.name);

/**
 * Every existing tool object: what any agent is built with, plus the Inven
 * premium-data tools, which live under analysis/tools but no general flavour
 * registers, and the equity-analysis calculator, which @minority and the
 * workforce list append rather than it living in one of the shared arrays.
 */
const EXISTING_TOOLS = new Set([
  ...tools,
  ...chatOnlyTools,
  ...workforceOnlyTools,
  ...investmentTools,
  ...combinedTools,
  ...vcTools,
  valyuSearch,
  invenPaidDataSourceSearch,
  invenPaidDataSourceEnrichment,
  financialEquityAnalysis,
]);

/**
 * Tools only the workforce may hold: the workforce-only list minus anything
 * chat also legitimately has (get_insight and send_email sit in both).
 */
const WORKFORCE_ONLY_NAMES = new Set(
  names(workforceOnlyTools).filter((n) => !names(chatOnlyTools).includes(n)),
);

const SETS = [
  ['minerba', MINERBA_TOOLS, MINERBA_EXTRA_TOOLS],
  ['dikti', DIKTI_TOOLS, DIKTI_EXTRA_TOOLS],
  ['bangun', BANGUN_TOOLS, BANGUN_EXTRA_TOOLS],
] as const;

describe.each(SETS)('%s tool set', (_key, set, extras) => {
  it.each(['chat', 'workforce'] as const)('%s role uses only existing tool objects, without duplicates', (role) => {
    for (const tool of set[role]) expect(EXISTING_TOOLS.has(tool)).toBe(true);
    const list = names(set[role]);
    expect(new Set(list).size).toBe(list.length);
  });

  it('chat role contains the chat core and the extras', () => {
    expect(names(set.chat)).toEqual(expect.arrayContaining(names(SECTOR_CHAT_CORE_TOOLS)));
    expect(names(set.chat)).toEqual(expect.arrayContaining(names(extras)));
  });

  it('workforce role contains the workforce core, the extras, narrate_step and ask_owner', () => {
    expect(names(set.workforce)).toEqual(expect.arrayContaining(names(SECTOR_WORKFORCE_CORE_TOOLS)));
    expect(names(set.workforce)).toEqual(expect.arrayContaining(names(extras)));
    expect(names(set.workforce)).toEqual(expect.arrayContaining(['narrate_step', 'ask_owner']));
  });

  it('chat role excludes every workforce-only tool', () => {
    for (const n of names(set.chat)) expect(WORKFORCE_ONLY_NAMES.has(n)).toBe(false);
  });

  it('workforce role excludes the chat-only approval cards, page tools and handoff', () => {
    for (const n of [
      'propose_workforce_handoff',
      'propose_insight_create',
      'propose_insight_edit',
      'propose_report_plan',
      'read_page_context',
      'navigate_page',
    ]) {
      expect(names(set.workforce)).not.toContain(n);
    }
  });

  it('extras are read-only: no pipeline writes, no chat-only or workforce-only tools', () => {
    for (const n of names(extras)) {
      expect(WORKFORCE_ONLY_NAMES.has(n)).toBe(false);
      expect(names(chatOnlyTools)).not.toContain(n);
    }
  });
});

describe('composeSectorTools', () => {
  it('skips an extra that is already in the core rather than registering it twice', () => {
    const composed = composeSectorTools([valyuSearch]);
    expect(names(composed.chat).filter((n) => n === 'valyu_search')).toHaveLength(1);
    expect(names(composed.workforce).filter((n) => n === 'valyu_search')).toHaveLength(1);
  });

  it('keeps the workforce-only trace, question and insight-write tools out of the chat core', () => {
    for (const n of [
      'narrate_step',
      'report_progress',
      'ask_owner',
      'create_insight',
      'edit_insight_section',
      'replace_insight_document',
    ]) {
      expect(names(SECTOR_CHAT_CORE_TOOLS)).not.toContain(n);
      expect(names(SECTOR_WORKFORCE_CORE_TOOLS)).toContain(n);
    }
  });
});

describe('premium data access', () => {
  const PREMIUM = [
    'valyu_search',
    'inven_paid_data_source_search',
    'inven_paid_data_source_enrichment',
  ];

  it.each([
    ['minerba', MINERBA_TOOLS],
    ['dikti', DIKTI_TOOLS],
  ] as const)('%s holds every premium data tool in both roles', (_key, set) => {
    expect(names(set.chat)).toEqual(expect.arrayContaining(PREMIUM));
    expect(names(set.workforce)).toEqual(expect.arrayContaining(PREMIUM));
    // AlphaSense is retired: no sector agent registers it in either role.
    expect(names(set.chat)).not.toContain('alphasense_search');
    expect(names(set.workforce)).not.toContain('alphasense_search');
  });

  it('@bangun is not granted Inven', () => {
    for (const role of ['chat', 'workforce'] as const) {
      expect(names(BANGUN_TOOLS[role])).not.toContain('inven_paid_data_source_search');
      expect(names(BANGUN_TOOLS[role])).not.toContain('inven_paid_data_source_enrichment');
    }
  });
});
