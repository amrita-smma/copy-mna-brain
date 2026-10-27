import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemMessage } from '@langchain/core/messages';

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn((_config: Record<string, unknown>) => ({
    streamEvents: vi.fn(async () => []),
    invoke: vi.fn(async () => ({ messages: [] })),
  })),
  dynamicSystemPromptMiddleware: vi.fn((fn: unknown) => ({ __dynamicSystemPrompt: fn })),
  anthropicOpts: [] as Record<string, unknown>[],
}));

vi.mock('langchain', () => ({
  createAgent: mocks.createAgent,
  dynamicSystemPromptMiddleware: mocks.dynamicSystemPromptMiddleware,
}));
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
  readPipelineOperationsGuide: { name: 'read_pipeline_operations_guide' },
}));

import {
  AgentGraph,
  PER_TURN_CONTEXT_KEY,
  additionalContextBlock,
  buildSystemMessage,
} from './runtime';

type TextBlock = { type: string; text: string; cache_control?: { type: string } };
type AgentConfig = {
  systemPrompt: SystemMessage;
  tools: { name: string }[];
  middleware: unknown[];
};
const lastAgentConfig = () =>
  mocks.createAgent.mock.calls[mocks.createAgent.mock.calls.length - 1][0] as unknown as AgentConfig;
const promptBlocks = (config: AgentConfig) => config.systemPrompt.content as TextBlock[];
const lastAgent = () =>
  mocks.createAgent.mock.results[mocks.createAgent.mock.results.length - 1].value as {
    streamEvents: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
  };
/** The function handed to dynamicSystemPromptMiddleware, as the agent would call it. */
const perTurnMiddlewareFn = () =>
  mocks.dynamicSystemPromptMiddleware.mock.calls[0][0] as (
    state: unknown,
    runtime: { configurable?: Record<string, unknown> },
  ) => string | SystemMessage;

describe('buildSystemMessage', () => {
  it('marks the fixed prompt as a cache breakpoint and keeps build-time context in its own uncached block', () => {
    const blocks = buildSystemMessage('FIXED', 'CTX').content as TextBlock[];
    expect(blocks).toEqual([
      { type: 'text', text: 'FIXED', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: additionalContextBlock('CTX') },
    ]);
    expect((buildSystemMessage('FIXED').content as TextBlock[]).map((b) => b.text)).toEqual(['FIXED']);
  });
});

describe('AgentGraph per-turn override', () => {
  const baseTools = [{ name: 'base_tool' }] as never;
  const baseMiddleware = [{ base: true }] as never;
  let graph: AgentGraph;

  let defaultAgentConfig: AgentConfig;
  let defaultAgent: ReturnType<typeof lastAgent>;

  beforeEach(() => {
    mocks.anthropicOpts.length = 0;
    graph = new AgentGraph({ apiKey: 'k' }, baseTools, 'BASE PROMPT', baseMiddleware);
    // The constructor compiles the default agent; the tests count what a turn adds.
    defaultAgentConfig = lastAgentConfig();
    defaultAgent = lastAgent();
    mocks.createAgent.mockClear();
  });

  it("exposes the graph's own prompt and tools for a bot to layer over", () => {
    expect(graph.getSystemPrompt()).toBe('BASE PROMPT');
    expect(graph.getToolList()).toBe(baseTools);
  });

  it('compiles the fixed prompt once with the cache breakpoint and appends the per-turn context at call time', async () => {
    const config = defaultAgentConfig;
    expect(promptBlocks(config)).toEqual([
      { type: 'text', text: 'BASE PROMPT', cache_control: { type: 'ephemeral' } },
    ]);
    // The per-turn middleware is always the last one, after the graph's own.
    expect(config.middleware.slice(0, -1)).toEqual(baseMiddleware);
    expect(config.middleware[config.middleware.length - 1]).toHaveProperty('__dynamicSystemPrompt');

    await graph.streamEvents({ messages: [], additionalSystemContext: 'CTX' }, { configurable: { thread_id: 't' } });
    const runConfig = defaultAgent.streamEvents.mock.calls[0][1] as { configurable: Record<string, unknown> };
    expect(runConfig.configurable).toEqual({ thread_id: 't', [PER_TURN_CONTEXT_KEY]: 'CTX' });

    // What the middleware appends for that turn: one plain block, no breakpoint.
    const appended = perTurnMiddlewareFn()({}, { configurable: runConfig.configurable }) as SystemMessage;
    expect(appended.content).toEqual([{ type: 'text', text: additionalContextBlock('CTX') }]);
    // And nothing at all on a turn without context.
    expect(perTurnMiddlewareFn()({}, { configurable: { thread_id: 't' } })).toBe('');
  });

  it('runs a plain turn with context on the default agent instead of compiling a new one', async () => {
    await graph.streamEvents({ messages: [], additionalSystemContext: 'CTX' });
    expect(mocks.createAgent).not.toHaveBeenCalled();
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
    expect(promptBlocks(config)).toEqual([
      { type: 'text', text: 'BOT PROMPT', cache_control: { type: 'ephemeral' } },
    ]);
    expect(config.tools.map((t) => t.name)).toEqual(['bot_tool']);
    expect(config.middleware.slice(0, -1)).toEqual(botMiddleware);
    const opts = mocks.anthropicOpts[mocks.anthropicOpts.length - 1];
    expect(opts.contextManagement).toEqual({ edits: [{ type: 'clear_tool_uses_20250919' }] });

    // The next plain turn is back on the graph's own prompt and tools.
    mocks.createAgent.mockClear();
    await graph.streamEvents({ messages: [], additionalSystemContext: 'CTX', withheldTools: ['x'] });
    const plain = lastAgentConfig();
    expect(promptBlocks(plain)[0].text).toBe('BASE PROMPT');
    expect(plain.tools.map((t) => t.name)).toEqual(['base_tool']);
    expect(plain.middleware.slice(0, -1)).toEqual(baseMiddleware);
  });

  it('reuses the compiled agent for the same override across turns, whatever the per-turn context', async () => {
    const botMiddleware = [{ bot: true }] as never;
    const override = { systemPrompt: 'BOT', toolList: [{ name: 'bot_tool' }] as never, middleware: botMiddleware };

    await graph.streamEvents({ messages: [], additionalSystemContext: 'CTX 1', override });
    await graph.streamEvents({ messages: [], additionalSystemContext: 'CTX 2', override });
    await graph.invoke({ messages: [], additionalSystemContext: 'CTX 3', override });

    expect(mocks.createAgent).toHaveBeenCalledTimes(1);
    const agent = lastAgent();
    expect(agent.streamEvents).toHaveBeenCalledTimes(2);
    expect(agent.invoke).toHaveBeenCalledTimes(1);
    expect((agent.invoke.mock.calls[0][1] as { configurable: Record<string, unknown> }).configurable).toMatchObject({
      [PER_TURN_CONTEXT_KEY]: 'CTX 3',
    });
  });

  it('compiles again when the prompt, the tools or the middleware differ', async () => {
    const middleware = [{ bot: true }] as never;
    await graph.streamEvents({ messages: [], override: { systemPrompt: 'A', toolList: [] as never, middleware } });
    await graph.streamEvents({ messages: [], override: { systemPrompt: 'B', toolList: [] as never, middleware } });
    await graph.streamEvents({
      messages: [],
      override: { systemPrompt: 'B', toolList: [{ name: 't' }] as never, middleware },
    });
    await graph.streamEvents({
      messages: [],
      override: { systemPrompt: 'B', toolList: [{ name: 't' }] as never, middleware: [{ other: true }] as never },
    });

    expect(mocks.createAgent).toHaveBeenCalledTimes(4);
  });

  it("keeps the graph's middleware when the override names none", async () => {
    await graph.invoke({
      messages: [],
      override: { systemPrompt: 'BOT', toolList: [] as never },
    });

    expect(lastAgentConfig().middleware.slice(0, -1)).toEqual(baseMiddleware);
  });
});
