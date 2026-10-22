import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn((_config: Record<string, unknown>) => ({
    streamEvents: vi.fn(async () => []),
    invoke: vi.fn(async () => ({ messages: [] })),
  })),
  anthropicOpts: [] as Record<string, unknown>[],
}));

vi.mock('langchain', () => ({ createAgent: mocks.createAgent }));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(opts: Record<string, unknown>) {
      mocks.anthropicOpts.push(opts);
    }
    withConfig() {
      return {};
    }
  },
}));
vi.mock('@/lib/langfuse', () => ({ withLangfuseCallbacks: (c: unknown) => c }));
vi.mock('@/lib/agents/analysis/tools', () => ({
  SERVER_TOOLS: [],
  tools: [],
  chatOnlyTools: [],
  valyuSearch: { name: 'valyu_search' },
}));

import { AgentGraph } from './runtime';

type AgentConfig = { systemPrompt: string; tools: { name: string }[]; middleware?: unknown[] };
const lastAgentConfig = () =>
  mocks.createAgent.mock.calls[mocks.createAgent.mock.calls.length - 1][0] as unknown as AgentConfig;

describe('AgentGraph per-turn override', () => {
  const baseTools = [{ name: 'base_tool' }] as never;
  const baseMiddleware = [{ base: true }] as never;
  let graph: AgentGraph;

  beforeEach(() => {
    mocks.createAgent.mockClear();
    mocks.anthropicOpts.length = 0;
    graph = new AgentGraph({ apiKey: 'k' }, baseTools, 'BASE PROMPT', baseMiddleware);
  });

  it("exposes the graph's own prompt and tools for a bot to layer over", () => {
    expect(graph.getSystemPrompt()).toBe('BASE PROMPT');
    expect(graph.getToolList()).toBe(baseTools);
  });

  it("swaps in the override's prompt, tools, middleware and context editing for that turn only", async () => {
    const botMiddleware = [{ bot: true }] as never;

    await graph.streamEvents({
      messages: [],
      additionalSystemContext: 'CTX',
      withheldTools: ['drop_me'],
      override: {
        systemPrompt: 'BOT PROMPT',
        toolList: [{ name: 'bot_tool' }, { name: 'drop_me' }] as never,
        middleware: botMiddleware,
        contextEditing: true,
      },
    });

    const config = lastAgentConfig();
    expect(config.systemPrompt.startsWith('BOT PROMPT')).toBe(true);
    expect(config.systemPrompt).toContain('CTX');
    expect(config.tools.map((t) => t.name)).toEqual(['bot_tool']);
    expect(config.middleware).toBe(botMiddleware);
    const opts = mocks.anthropicOpts[mocks.anthropicOpts.length - 1];
    expect(opts.contextManagement).toEqual({ edits: [{ type: 'clear_tool_uses_20250919' }] });

    // The next plain turn is back on the graph's own prompt and tools.
    await graph.streamEvents({ messages: [], additionalSystemContext: 'CTX' });
    const plain = lastAgentConfig();
    expect(plain.systemPrompt.startsWith('BASE PROMPT')).toBe(true);
    expect(plain.tools.map((t) => t.name)).toEqual(['base_tool']);
    expect(plain.middleware).toBe(baseMiddleware);
  });

  it("keeps the graph's middleware when the override names none", async () => {
    await graph.invoke({
      messages: [],
      override: { systemPrompt: 'BOT', toolList: [] as never },
    });

    expect(lastAgentConfig().middleware).toBe(baseMiddleware);
  });
});
