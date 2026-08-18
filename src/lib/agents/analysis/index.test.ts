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
  // Include a `query_fund_sources` entry so the source-of-funds gating in
  // getAgentGraph has something to strip.
  investmentTools: [{ name: 'query_funds' }, { name: 'query_fund_sources' }],
  combinedTools: [{ name: 'add_company' }, { name: 'query_fund_sources' }],
  vcTools: [
    { name: 'query_companies' },
    { name: 'get_investment_theses' },
    { name: 'query_funds' },
    { name: 'query_fund_sources' },
    { name: 'valyu_search' },
    { name: 'valyu_extract_content' },
    { name: 'get_company_profile' },
    { name: 'get_sector_context' },
    { name: 'get_competitor_landscape' },
    { name: 'get_regulatory_context' },
    { name: 'get_market_signals' },
    { name: 'calculate_investment_returns' },
  ],
  valyuSearch: { name: 'valyu_search' },
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

  it('tells the investment flavor to resolve a named entity with search_investments first', async () => {
    await getAgentGraph('investment');

    const investmentPrompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    // "How is X doing?" must go through the cross-entity fuzzy lookup rather
    // than a guess at whether X is a holding, fund, LP, or capital source.
    expect(investmentPrompt).toContain('search_investments');
    expect(investmentPrompt).toContain('How is X doing?');
    expect(investmentPrompt).toMatch(/holding[\s\S]*fund[\s\S]*investor[\s\S]*capital/i);
  });

  it('equips the M&A flavor with valyu_search', async () => {
    await getAgentGraph('mna');

    const mnaTools = mocks.createAgent.mock.calls[0][0].tools as { name: string }[];
    expect(mnaTools.map((t) => t.name)).toContain('valyu_search');
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

  it('builds the vc flavor with its own tool list and distinct prompt', async () => {
    await getAgentGraph('vc');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;
    const tools = mocks.createAgent.mock.calls[0][0].tools as Array<{ name: string }>;

    expect(prompt).toContain('Venture Capital & Growth Equity Analysis Copilot');
    expect(prompt).toContain('get_investment_theses');
    expect(prompt).toContain('get_company_profile');
    expect(prompt).toContain('get_sector_context');
    expect(prompt).toContain('get_competitor_landscape');
    expect(prompt).toContain('get_regulatory_context');
    expect(prompt).toContain('get_market_signals');
    expect(prompt).toContain('calculate_investment_returns');
    expect(prompt).toContain('valyu_extract_content');
    expect(prompt).toContain('<!-- THINKING_START -->');
    expect(tools.map((t) => t.name)).toEqual([
      'query_companies',
      'get_investment_theses',
      'query_funds',
      'query_fund_sources',
      'valyu_search',
      'valyu_extract_content',
      'get_company_profile',
      'get_sector_context',
      'get_competitor_landscape',
      'get_regulatory_context',
      'get_market_signals',
      'calculate_investment_returns',
    ]);
  });

  it('instructs the vc flavor on Valyu search, topic tools, content extraction, routing guidance, and factual boundaries', async () => {
    await getAgentGraph('vc');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    // Available tools list numbering
    expect(prompt).toMatch(/17\.\s+\*\*valyu_search\*\*/);
    expect(prompt).toMatch(/18\.\s+\*\*valyu_extract_content\*\*/);
    expect(prompt).toMatch(/19\.\s+\*\*get_company_profile\*\*/);
    expect(prompt).toMatch(/20\.\s+\*\*get_sector_context\*\*/);
    expect(prompt).toMatch(/21\.\s+\*\*get_competitor_landscape\*\*/);
    expect(prompt).toMatch(/22\.\s+\*\*get_regulatory_context\*\*/);
    expect(prompt).toMatch(/23\.\s+\*\*get_market_signals\*\*/);
    expect(prompt).toMatch(/24\.\s+\*\*calculate_investment_returns\*\*/);
    expect(prompt).toMatch(/25\.\s+\*\*lookup_user\*\*/);
    expect(prompt).toMatch(/26\.\s+\*\*send_email\*\*/);
    expect(prompt).toMatch(/27\.\s+\*\*propose_workforce_handoff\*\*/);

    // Valyu search vs topic tools vs content extraction roles and web_search fallback
    expect(prompt).toMatch(/prefer focused topic tools/i);
    expect(prompt).toMatch(/choose the narrowest relevant topic tool/i);
    expect(prompt).toMatch(/invoke multiple topic research tools in parallel/i);
    expect(prompt).toMatch(/generic `valyu_search` for ad-hoc/i);
    expect(prompt).toMatch(/`valyu_extract_content` to deeply inspect a small number/i);
    expect(prompt).toMatch(/retain `web_search` as a fallback/i);

    // Topic tools focus areas
    expect(prompt).toMatch(/company overview, founders/i);
    expect(prompt).toMatch(/market sizing, cagr/i);
    expect(prompt).toMatch(/direct competitors, substitute products/i);
    expect(prompt).toMatch(/regulatory requirements, compliance policies/i);
    expect(prompt).toMatch(/recent news events, executive turnover/i);
    expect(prompt).toMatch(/exit comparables/i);

    // Factual boundaries and private data gaps
    expect(prompt).toMatch(/private cap-tables/i);
    expect(prompt).toMatch(/report it as a data gap rather than guessing/i);

    // Preserved agentic behavior (no rigid sequence, no delegated verdict)
    expect(prompt).toMatch(/no rigid formulas or delegated judgment/i);
    expect(prompt).toMatch(/final investment judgment and synthesis is yours and must not be delegated/i);
  });

  it('memoizes the vc flavor independently from mna, investment, and combined', async () => {
    const mna = await getAgentGraph('mna');
    const investment = await getAgentGraph('investment');
    const combined = await getAgentGraph('combined');
    const vc = await getAgentGraph('vc');

    expect(vc).not.toBe(mna);
    expect(vc).not.toBe(investment);
    expect(vc).not.toBe(combined);
    expect(mocks.createAgent).toHaveBeenCalledTimes(4);

    expect(await getAgentGraph('vc')).toBe(vc);
    expect(mocks.createAgent).toHaveBeenCalledTimes(4);
  });

  it('builds high-effort vc agent with Opus model and memoizes separately', async () => {
    const medium = await getAgentGraph('vc', 'medium');
    const high = await getAgentGraph('vc', 'high');

    expect(high).not.toBe(medium);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);

    const mediumModel = mocks.createAgent.mock.calls[0][0].model as {
      opts: Record<string, unknown>;
    };
    const highModel = mocks.createAgent.mock.calls[1][0].model as {
      opts: Record<string, unknown>;
    };

    expect(mediumModel.opts.model).toBe('claude-sonnet-5');
    expect(highModel.opts.model).toBe('claude-opus-4-8');

    expect(await getAgentGraph('vc', 'high')).toBe(high);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
  });
});

describe('getAgentGraph source-of-funds gating', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const toolNames = (callIdx: number) =>
    (mocks.createAgent.mock.calls[callIdx][0].tools as Array<{ name: string }>).map(
      (t) => t.name,
    );

  it('includes query_fund_sources for the investment flavor when enabled (the default)', async () => {
    await getAgentGraph('investment', 'medium', true);
    expect(toolNames(0)).toContain('query_fund_sources');
  });

  it('strips query_fund_sources from the investment flavor when disabled', async () => {
    await getAgentGraph('investment', 'medium', false);
    expect(toolNames(0)).not.toContain('query_fund_sources');
    // Other investment tools survive.
    expect(toolNames(0)).toContain('query_funds');
  });

  it('strips query_fund_sources from the combined flavor when disabled', async () => {
    await getAgentGraph('combined', 'medium', false);
    expect(toolNames(0)).not.toContain('query_fund_sources');
    expect(toolNames(0)).toContain('add_company');
  });

  it('includes query_fund_sources for the vc flavor when enabled (the default)', async () => {
    await getAgentGraph('vc', 'medium', true);
    expect(toolNames(0)).toContain('query_fund_sources');
    expect(toolNames(0)).toContain('calculate_investment_returns');
  });

  it('strips query_fund_sources from the vc flavor when disabled', async () => {
    await getAgentGraph('vc', 'medium', false);
    expect(toolNames(0)).not.toContain('query_fund_sources');
    expect(toolNames(0)).toContain('calculate_investment_returns');
    expect(toolNames(0)).toContain('get_investment_theses');
  });

  it('memoizes enabled and disabled graphs as distinct singletons', async () => {
    const enabled = await getAgentGraph('investment', 'medium', true);
    const disabled = await getAgentGraph('investment', 'medium', false);
    expect(disabled).not.toBe(enabled);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
    // Re-requesting each returns its own cached instance.
    expect(await getAgentGraph('investment', 'medium', true)).toBe(enabled);
    expect(await getAgentGraph('investment', 'medium', false)).toBe(disabled);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
  });

  it('memoizes enabled and disabled vc graphs as distinct singletons', async () => {
    const enabled = await getAgentGraph('vc', 'medium', true);
    const disabled = await getAgentGraph('vc', 'medium', false);
    expect(disabled).not.toBe(enabled);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
    expect(await getAgentGraph('vc', 'medium', true)).toBe(enabled);
    expect(await getAgentGraph('vc', 'medium', false)).toBe(disabled);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
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
