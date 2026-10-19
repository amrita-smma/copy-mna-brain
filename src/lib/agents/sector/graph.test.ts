import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn((_config: Record<string, unknown>) => ({
    streamEvents: vi.fn(),
    invoke: vi.fn(),
  })),
  humanInTheLoopMiddleware: vi.fn((config: unknown) => ({ __middleware: true, config })),
  chatAnthropicOpts: [] as Array<Record<string, unknown>>,
}));

vi.mock('langchain', () => ({
  createAgent: mocks.createAgent,
  humanInTheLoopMiddleware: mocks.humanInTheLoopMiddleware,
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(public opts: Record<string, unknown>) {
      mocks.chatAnthropicOpts.push(opts);
    }
    withConfig() {
      return { opts: this.opts };
    }
  },
}));

vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: class {
    setup = vi.fn().mockResolvedValue(undefined);
  },
}));

// Real db module for the tools' imports; only the checkpointer's env readers
// are pinned so no real connection config is needed.
vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLocalPostgresHost: vi.fn(() => true),
  parseExplicitDbFromEnv: vi.fn(() => ({
    host: 'localhost',
    port: 5432,
    database: 'test',
    user: 'test',
    password: 'test',
  })),
  rdsIamAuthToken: vi.fn(),
  rdsIamDbAuthFromEnv: vi.fn(() => false),
}));

// graph.ts imports the analysis agent first, which is the import order that
// keeps the tools <-> workforce-trigger cycle resolving (see coreTools.test.ts).
import { getSectorAgentGraph, getSectorAgentSpec } from './graph';
import {
  CONSOLE_NAVIGATION_GUIDE,
  INSIGHT_AUTHORING_GUIDE,
  INSIGHT_TEMPLATE_AUTHORING_GUIDE,
  WORKFORCE_HITL_MIDDLEWARE,
  WORKFORCE_INSIGHT_AUTHORING_GUIDE,
  WORKFORCE_REPORTING_FORMAT,
  WORKFORCE_TRACE_TOOLS_GUIDE,
  resetAgent,
} from '@/lib/agents/analysis';
import {
  tools,
  chatOnlyTools,
  workforceOnlyTools,
  investmentTools,
  combinedTools,
  vcTools,
  valyuSearch,
} from '@/lib/agents/analysis/tools';
import { COMPANY_MENTIONS_PROMPT_GUIDE } from '@/lib/navigation/companyMentions';
import { MINERBA_PROMPT } from '@/lib/agents/minerba/prompt';
import { DIKTI_PROMPT } from '@/lib/agents/dikti/prompt';
import { BANGUN_PROMPT } from '@/lib/agents/bangun/prompt';
import { getMinerbaAgentGraph } from '@/lib/agents/minerba';
import { getDiktiAgentGraph } from '@/lib/agents/dikti';
import { getBangunAgentGraph } from '@/lib/agents/bangun';
import type { SectorAgentKey, SectorAgentRole } from './types';

const KEYS: SectorAgentKey[] = ['minerba', 'dikti', 'bangun'];
const ROLES: SectorAgentRole[] = ['chat', 'workforce'];
const SECTOR_PROMPTS: Record<SectorAgentKey, string> = {
  minerba: MINERBA_PROMPT,
  dikti: DIKTI_PROMPT,
  bangun: BANGUN_PROMPT,
};

/** Every tool name any agent in the app knows. */
const ALL_TOOL_NAMES = [
  ...new Set(
    [
      ...tools,
      ...chatOnlyTools,
      ...workforceOnlyTools,
      ...investmentTools,
      ...combinedTools,
      ...vcTools,
      valyuSearch,
    ].map((t) => t.name),
  ),
];

/**
 * Tool names a reused workforce fragment mentions only to say "don't":
 * WORKFORCE_QUESTION_TOOL_GUIDE says ask_owner is never called alongside
 * move_stage. The fragment is shared byte-for-byte with the general
 * workforce prompt, so it is allowed rather than forked.
 */
const NEGATIVE_MENTIONS: Record<SectorAgentRole, string[]> = {
  chat: [],
  workforce: ['move_stage'],
};

function lastCreateAgentConfig() {
  const calls = mocks.createAgent.mock.calls;
  return calls[calls.length - 1][0] as {
    systemPrompt: string;
    tools: Array<{ name: string }>;
    middleware?: unknown[];
  };
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  resetAgent();
  mocks.createAgent.mockClear();
  mocks.chatAnthropicOpts.length = 0;
});

describe.each(KEYS)('getSectorAgentSpec(%s)', (key) => {
  it.each(ROLES)('%s prompt only names tools the role actually has', (role) => {
    const { tools: roleTools, systemPrompt } = getSectorAgentSpec(key, role);
    const have = new Set(roleTools.map((t) => t.name));
    const mentioned = ALL_TOOL_NAMES.filter((n) =>
      new RegExp(`(^|[^a-z_])${n}([^a-z_]|$)`).test(systemPrompt),
    );
    // Guard against a vacuous pass: the prompt does name tools.
    expect(mentioned).toEqual(expect.arrayContaining(['web_search', 'get_insight']));
    const missing = mentioned.filter((n) => !have.has(n) && !NEGATIVE_MENTIONS[role].includes(n));
    expect(missing).toEqual([]);
  });

  it('chat prompt is the sector prompt plus the shared chat guides', () => {
    const { systemPrompt } = getSectorAgentSpec(key, 'chat');
    expect(systemPrompt.startsWith(SECTOR_PROMPTS[key])).toBe(true);
    expect(systemPrompt).toContain(INSIGHT_AUTHORING_GUIDE);
    expect(systemPrompt).toContain(CONSOLE_NAVIGATION_GUIDE);
    expect(systemPrompt).toContain(COMPANY_MENTIONS_PROMPT_GUIDE);
    expect(systemPrompt).toContain('## Grounding: Internal Records and the Outside World');
    // The console guide refers to this section by name.
    expect(systemPrompt).toContain('## Adding a New Company (Chat-Initiated)');
    expect(systemPrompt).not.toContain('## Reporting Format');
    // Sector agents read templates but don't author them.
    expect(systemPrompt).not.toContain(INSIGHT_TEMPLATE_AUTHORING_GUIDE);
    expect(systemPrompt).not.toContain('propose_insight_template_create');
  });

  it('workforce prompt is the sector prompt plus the workforce report contract', () => {
    const { systemPrompt } = getSectorAgentSpec(key, 'workforce');
    expect(systemPrompt).toContain(SECTOR_PROMPTS[key]);
    expect(systemPrompt).toContain(`running as @${key}`);
    expect(systemPrompt).toContain(WORKFORCE_REPORTING_FORMAT);
    expect(systemPrompt).toContain(WORKFORCE_TRACE_TOOLS_GUIDE);
    expect(systemPrompt).toContain(WORKFORCE_INSIGHT_AUTHORING_GUIDE);
    expect(systemPrompt).toContain('**Scheduled refresh runs:**');
    // The M&A catalogue and pipeline rules stay with the general workforce.
    expect(systemPrompt).not.toContain('## Choosing the intake stage');
    expect(systemPrompt).not.toContain('## Forming an AI Opinion');
    expect(systemPrompt).not.toContain(INSIGHT_AUTHORING_GUIDE);
  });
});

describe('getSectorAgentGraph', () => {
  const ROLE_CONFIG = [
    ['chat', 'low', undefined, undefined, 'claude-sonnet-5-5'],
    ['workforce', 'high', [WORKFORCE_HITL_MIDDLEWARE], { edits: [{ type: 'clear_tool_uses_20250919' }] }, 'claude-opus-5-5'],
  ] as const;

  describe.each(KEYS)('%s', (key) => {
    it.each(ROLE_CONFIG)(
      'builds the %s graph at %s effort from its spec with the role middleware, context editing and model',
      async (role, effort, middleware, contextManagement, model) => {
        expect(await getSectorAgentGraph(key, role, effort)).not.toBeNull();
        const config = lastCreateAgentConfig();
        const spec = getSectorAgentSpec(key, role);
        expect(config.systemPrompt).toBe(spec.systemPrompt);
        expect(config.tools.map((t) => t.name)).toEqual(spec.tools.map((t) => t.name));
        expect(config.middleware).toEqual(middleware);
        const opts = mocks.chatAnthropicOpts[mocks.chatAnthropicOpts.length - 1];
        expect(opts.contextManagement).toEqual(contextManagement);
        expect(opts.model).toBe(model);
      },
    );
  });

  it('caches per key:role:effort, and resetAgent() clears the cache', async () => {
    const a = await getSectorAgentGraph('minerba', 'chat', 'medium');
    expect(await getSectorAgentGraph('minerba', 'chat', 'medium')).toBe(a);
    expect(mocks.createAgent).toHaveBeenCalledTimes(1);

    const otherEffort = await getSectorAgentGraph('minerba', 'chat', 'high');
    const otherRole = await getSectorAgentGraph('minerba', 'workforce', 'medium');
    const otherKey = await getSectorAgentGraph('dikti', 'chat', 'medium');
    expect(new Set([a, otherEffort, otherRole, otherKey]).size).toBe(4);

    resetAgent();
    expect(await getSectorAgentGraph('minerba', 'chat', 'medium')).not.toBe(a);
    expect(mocks.createAgent).toHaveBeenCalledTimes(5);
  });

  it('returns null without caching when the API key is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await getSectorAgentGraph('dikti', 'chat', 'medium')).toBeNull();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(await getSectorAgentGraph('dikti', 'chat', 'medium')).not.toBeNull();
  });
});

describe('agent entrypoints', () => {
  it('route to the shared builder with their own key', async () => {
    expect(await getMinerbaAgentGraph('chat', 'low')).toBe(await getSectorAgentGraph('minerba', 'chat', 'low'));
    expect(await getDiktiAgentGraph('workforce')).toBe(await getSectorAgentGraph('dikti', 'workforce', 'medium'));
    expect(await getBangunAgentGraph('chat', 'high')).toBe(await getSectorAgentGraph('bangun', 'chat', 'high'));
    expect(mocks.createAgent).toHaveBeenCalledTimes(3);
  });
});
