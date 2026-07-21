import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock fns so the module-level vi.mock factories can reference them.
const mocks = vi.hoisted(() => ({
  createAgent: vi.fn((_config: Record<string, unknown>) => ({
    __agent: true,
    streamEvents: vi.fn().mockResolvedValue('event-stream'),
    invoke: vi.fn().mockResolvedValue({ messages: [] }),
  })),
  humanInTheLoopMiddleware: vi.fn(() => ({ __middleware: true })),
  postgresSaverCtor: vi.fn(),
  postgresSaverSetup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('langchain', () => ({
  createAgent: mocks.createAgent,
  humanInTheLoopMiddleware: mocks.humanInTheLoopMiddleware,
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(public opts: unknown) {}
  },
}));

// Track whether a PostgresSaver was ever constructed. The stateless graph must
// never touch it.
vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: class {
    constructor(...args: unknown[]) {
      mocks.postgresSaverCtor(...args);
    }
    setup = mocks.postgresSaverSetup;
  },
}));

// The real tools module pulls in repositories/db — stub it out so the agent
// module loads without any I/O wiring.
vi.mock('@/lib/agents/analysis/tools', () => ({
  tools: [],
  chatOnlyTools: [],
  workforceOnlyTools: [],
  investmentTools: [],
  combinedTools: [],
}));

// db.ts constructs a Postgres client at module load and throws without DB env
// vars. The stateless path never calls these helpers, so stub them out.
vi.mock('@/lib/server/db', () => ({
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

import {
  extractMessageText,
  extractFirstTurn,
  getStatelessAgentGraph,
  getAgentGraph,
  resetAgent,
} from '@/lib/agents/analysis';
import type { BaseMessage } from '@langchain/core/messages';

// Minimal stand-in for a message — extractMessageText only reads `.content`.
const msg = (content: unknown) => ({ content }) as unknown as BaseMessage;
// Stand-in that also carries a role, for extractFirstTurn (uses _getType()).
const typed = (type: 'human' | 'ai' | 'tool', content: unknown) =>
  ({ content, _getType: () => type }) as unknown as BaseMessage;

describe('getStatelessAgentGraph', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    mocks.postgresSaverCtor.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds the agent with no checkpointer (stateless)', async () => {
    const graph = await getStatelessAgentGraph();

    expect(graph).not.toBeNull();
    expect(mocks.createAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createAgent.mock.calls[0][0]).toMatchObject({
      checkpointer: undefined,
    });
  });

  it('never constructs a PostgresSaver', async () => {
    await getStatelessAgentGraph();
    expect(mocks.postgresSaverCtor).not.toHaveBeenCalled();
  });

  it('returns the same singleton instance on repeated calls', async () => {
    const first = await getStatelessAgentGraph();
    const second = await getStatelessAgentGraph();

    expect(first).toBe(second);
    expect(mocks.createAgent).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after resetAgent clears the singleton', async () => {
    const first = await getStatelessAgentGraph();
    resetAgent();
    const second = await getStatelessAgentGraph();

    expect(first).not.toBe(second);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
  });

  it('returns null when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const graph = await getStatelessAgentGraph();
    expect(graph).toBeNull();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it('constructs the Sonnet 5 model without a temperature sampling param', async () => {
    // Sonnet 5 returns 400 "temperature is deprecated for this model" if a
    // temperature is sent. The model must be built with temperature unset so
    // ChatAnthropic omits the field from the request.
    await getStatelessAgentGraph();

    const model = mocks.createAgent.mock.calls[0][0].model as {
      opts: Record<string, unknown>;
    };
    expect(model.opts.model).toBe('claude-sonnet-5');
    expect(model.opts.temperature).toBeUndefined();
  });

  it('constructs the model with token streaming enabled', async () => {
    // With maxTokens 128000, the Anthropic SDK rejects non-streaming requests
    // ("Streaming is required for operations that may take longer than 10
    // minutes"). AgentGraph.invoke (used by the workforce runtime and one-shot
    // job handlers) makes a non-streaming call, so the model itself must stream
    // at the Messages API level — LangGraph's agent.invoke() alone does not.
    await getStatelessAgentGraph();

    const model = mocks.createAgent.mock.calls[0][0].model as {
      opts: Record<string, unknown>;
    };
    expect(model.opts.streaming).toBe(true);
  });
});

describe('getAgentGraph flavor selection', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to the M&A flavor and memoizes it separately from 'investment'", async () => {
    const mna = await getAgentGraph();
    const mnaAgain = await getAgentGraph('mna');
    expect(mna).toBe(mnaAgain);
    expect(mocks.createAgent).toHaveBeenCalledTimes(1);

    const investment = await getAgentGraph('investment');
    expect(investment).not.toBe(mna);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);

    // Each flavor is its own singleton after the first build.
    expect(await getAgentGraph('investment')).toBe(investment);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
  });

  it('builds the investment flavor with a distinct system prompt', async () => {
    await getAgentGraph('mna');
    await getAgentGraph('investment');

    const mnaPrompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;
    const investmentPrompt = mocks.createAgent.mock.calls[1][0].systemPrompt as string;

    expect(mnaPrompt).not.toBe(investmentPrompt);
    expect(investmentPrompt).toContain('Investment & Funds Analysis Assistant');
  });

  it('builds the combined flavor as its own memoized singleton with a distinct prompt', async () => {
    const mna = await getAgentGraph('mna');
    const combined = await getAgentGraph('combined');
    expect(combined).not.toBe(mna);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);

    // Memoized separately from the other flavors.
    expect(await getAgentGraph('combined')).toBe(combined);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);

    const combinedPrompt = mocks.createAgent.mock.calls[1][0].systemPrompt as string;
    expect(combinedPrompt).toContain('M&A + Investment Analysis Assistant');
  });
});

describe('AgentGraph abort signal forwarding', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the abort signal to the underlying agent on streamEvents', async () => {
    const graph = await getStatelessAgentGraph();
    const controller = new AbortController();

    await graph!.streamEvents(
      { messages: [], additionalSystemContext: undefined },
      { version: 'v2', signal: controller.signal },
    );

    const underlying = mocks.createAgent.mock.results[0].value;
    expect(underlying.streamEvents).toHaveBeenCalledWith(
      { messages: [] },
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('forwards the abort signal to the underlying agent on invoke', async () => {
    const graph = await getStatelessAgentGraph();
    const controller = new AbortController();

    await graph!.invoke(
      { messages: [], additionalSystemContext: undefined },
      { signal: controller.signal },
    );

    const underlying = mocks.createAgent.mock.results[0].value;
    expect(underlying.invoke).toHaveBeenCalledWith(
      { messages: [] },
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('extractMessageText', () => {
  it('returns plain string content unchanged', () => {
    expect(extractMessageText(msg('{"result":"pass"}'))).toBe(
      '{"result":"pass"}',
    );
  });

  it('concatenates the text of array content blocks', () => {
    const content = [
      { type: 'text', text: '{"business_overview":' },
      { type: 'text', text: '"- foo"}' },
    ];
    expect(extractMessageText(msg(content))).toBe(
      '{"business_overview":"- foo"}',
    );
  });

  it('preserves embedded JSON in a single text block (the tool-agent case)', () => {
    // The real failure: Anthropic returns the final answer as a content-block
    // array. JSON.stringify mangled the embedded JSON; extractMessageText must
    // hand back the raw text so downstream JSON.parse succeeds.
    const json = '{"result":"pass","remarks":"line one line two"}';
    const parsed = JSON.parse(
      extractMessageText(msg([{ type: 'text', text: json }])),
    );
    expect(parsed.result).toBe('pass');
  });

  it('ignores non-text blocks (e.g. tool_use)', () => {
    const content = [
      { type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'x' } },
      { type: 'text', text: 'final answer' },
    ];
    expect(extractMessageText(msg(content))).toBe('final answer');
  });

  it('returns empty string for undefined or empty content', () => {
    expect(extractMessageText(undefined)).toBe('');
    expect(extractMessageText(msg([]))).toBe('');
  });
});

describe('extractFirstTurn', () => {
  it('returns the first human and first ai message, ignoring later turns', () => {
    const messages = [
      typed('human', 'first question'),
      typed('ai', 'first answer'),
      typed('human', 'second question'),
      typed('ai', 'second answer'),
    ];
    expect(extractFirstTurn(messages)).toEqual({
      userText: 'first question',
      assistantText: 'first answer',
    });
  });

  it('skips tool messages when picking the first ai message', () => {
    const messages = [
      typed('human', 'q'),
      typed('tool', 'tool output'),
      typed('ai', 'the answer'),
    ];
    expect(extractFirstTurn(messages)).toEqual({
      userText: 'q',
      assistantText: 'the answer',
    });
  });

  it('returns the FULL assistant reply across a tool-using turn, not the first blob', () => {
    // Real tool turn: AI tool-call (no text) → Tool result → AI final answer.
    const messages = [
      typed('human', 'q'),
      typed('ai', ''), // tool-call message, empty text
      typed('tool', 'tool output'),
      typed('ai', 'the full final answer'),
    ];
    expect(extractFirstTurn(messages).assistantText).toBe('the full final answer');
  });

  it('concatenates interim and final assistant text within the first turn', () => {
    const messages = [
      typed('human', 'q'),
      typed('ai', 'Let me check.'),
      typed('tool', 'result'),
      typed('ai', 'The answer is X.'),
      typed('human', 'follow up'),
      typed('ai', 'ignored second-turn answer'),
    ];
    expect(extractFirstTurn(messages).assistantText).toBe(
      'Let me check.\n\nThe answer is X.',
    );
  });

  it('returns empty assistantText when there is no ai message yet', () => {
    expect(extractFirstTurn([typed('human', 'pending question')])).toEqual({
      userText: 'pending question',
      assistantText: '',
    });
  });

  it('returns empty strings for an empty thread', () => {
    expect(extractFirstTurn([])).toEqual({ userText: '', assistantText: '' });
  });
});
