import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

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
  serverTools: [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
  ],
}));

vi.mock('langchain', () => ({
  createAgent: mocks.createAgent,
  humanInTheLoopMiddleware: mocks.humanInTheLoopMiddleware,
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(public opts: Record<string, unknown>) {}
    withConfig(config: Record<string, unknown>) {
      return {
        bound: this,
        opts: this.opts,
        config,
      };
    }
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
  SERVER_TOOLS: mocks.serverTools,
  tools: [...mocks.serverTools],
  chatOnlyTools: [],
  workforceOnlyTools: [],
  // Include a `query_fund_sources` entry so the source-of-funds gating in
  // getAgentGraph has something to strip.
  investmentTools: [
    { name: 'query_funds' },
    { name: 'query_fund_sources' },
    ...mocks.serverTools,
  ],
  combinedTools: [
    { name: 'add_company' },
    { name: 'query_fund_sources' },
    ...mocks.serverTools,
  ],
  vcTools: [
    { name: 'query_companies' },
    { name: 'get_investment_theses' },
    { name: 'query_funds' },
    { name: 'query_fund_sources' },
    ...mocks.serverTools,
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
  // The read-only tools the crowdfunding (five) and the advisory /
  // capital-markets (seven) flavors add on top of the M&A chat list.
  calculateInvestmentReturns: { name: 'calculate_investment_returns' },
  getCompanyProfile: { name: 'get_company_profile' },
  getCompetitorLandscape: { name: 'get_competitor_landscape' },
  getMarketSignals: { name: 'get_market_signals' },
  getRegulatoryContext: { name: 'get_regulatory_context' },
  getSectorContext: { name: 'get_sector_context' },
  valyuExtractContent: { name: 'valyu_extract_content' },
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
  createLocalAgent,
  extractMessageText,
  extractFirstTurn,
  getStatelessAgentGraph,
  getAgentGraph,
  AgentGraph,
  getWorkforceAgentGraphForEffort,
  resetAgent,
  EFFORT_TIERS,
  CHAT_TURN_BUDGET_CEILING_MS,
  maxEffort,
  asEffortChoice,
  asManualEffort,
  withoutTools,
  type CopilotAgentType,
  type EffortChoice,
  type ToolList,
} from '@/lib/agents/analysis';
import { WORKFORCE_HITL_INTERRUPT_ON } from '@/lib/agents/analysis/hitl';
import { logger } from '@/lib/agents/logger';
import type { BaseMessage } from '@langchain/core/messages';

// The workforce HITL middleware is built once at module load; capture its
// config before any afterEach clears the mock's call log.
const workforceHitlConfig = (mocks.humanInTheLoopMiddleware.mock.calls as unknown[][])[0]?.[0] as
  | { interruptOn?: Record<string, unknown> }
  | undefined;

describe('workforce HITL middleware', () => {
  it('gates exactly ask_owner and promote_to_l1 with the shared interrupt config', () => {
    expect(workforceHitlConfig?.interruptOn).toBe(WORKFORCE_HITL_INTERRUPT_ON);
    expect(Object.keys(workforceHitlConfig?.interruptOn ?? {}).sort()).toEqual([
      'ask_owner',
      'promote_to_l1',
    ]);
  });
});

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

  // Field-level company edits (rename, financials, segment, banker) are writes,
  // so the chat flavor must route them to the Workforce rather than implying it
  // can apply them inline.
  it('routes company detail edits through the workforce handoff in the M&A prompt', async () => {
    await getAgentGraph('mna');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    expect(prompt).toContain('## Editing Company Details');
    expect(prompt).toContain('update_company_details');
    expect(prompt).toMatch(/only by the Workforce/i);
    expect(prompt).toMatch(/editing a company's stored details/i);
    // The Workforce cannot see this conversation, so the instruction has to
    // carry the company id, the field, and the exact value.
    expect(prompt).toMatch(/exact, self-contained field-level order/i);
  });

  it('documents update_company_details as a workforce write tool', async () => {
    await getWorkforceAgentGraphForEffort('medium');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    expect(prompt).toContain('## Editing company details');
    expect(prompt).toContain('**update_company_details**');
    // Its boundaries must stay explicit: the HITL-gated promotion path and the
    // drop path must not be reachable through a detail edit.
    expect(prompt).toMatch(/promote_to_l0[^\n]*promote_to_l1/);
    expect(prompt).toMatch(/dropping goes through `drop_company`/);
    expect(prompt).toMatch(/Never invent a number/i);
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
    expect(prompt).not.toContain('<!-- THINKING_START -->');
    expect(prompt).not.toContain('<!-- THINKING_END -->');
    expect(tools.map((t) => t.name)).toEqual([
      'query_companies',
      'get_investment_theses',
      'query_funds',
      'query_fund_sources',
      'web_search',
      'web_fetch',
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
    expect(prompt).toMatch(/16\.\s+\*\*web_search\*\*/);
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
    expect(prompt).toMatch(/reach for `web_search` freely/i);

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
    expect(highModel.opts.model).toBe('claude-opus-5');

    expect(await getAgentGraph('vc', 'high')).toBe(high);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
  });

  // The Minority Stakes Portfolio Manager is the one flavor defined by its
  // prompt alone: same tools as M&A, a different job.
  it('gives the minority flavor the SAME tool list as mna', async () => {
    await getAgentGraph('mna');
    await getAgentGraph('minority');

    const mnaTools = (mocks.createAgent.mock.calls[0][0].tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    const minorityTools = (
      mocks.createAgent.mock.calls[1][0].tools as Array<{ name: string }>
    ).map((t) => t.name);

    expect(minorityTools).toEqual(mnaTools);
  });

  it('builds the minority flavor with its own portfolio-manager prompt', async () => {
    await getAgentGraph('minority');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    expect(prompt).toContain('Minority Stakes Portfolio Manager');
    // Its three framing questions: passive ownership, portfolio impact, exit.
    expect(prompt).toMatch(/good business we can live with passively/i);
    expect(prompt).toMatch(/What does this do to the PORTFOLIO\?/);
    expect(prompt).toMatch(/How do we get out/i);
    // The judgment lenses that distinguish it from the control-deal flavors.
    expect(prompt).toContain('## Portfolio Manager Judgment');
    expect(prompt).toMatch(/Position sizing before conviction/);
    expect(prompt).toMatch(/Marginal portfolio impact, not standalone merit/);
    expect(prompt).toMatch(/Minority protections are the downside case/);
    expect(prompt).toMatch(/Exit path, named and dated/);
    // It is not the M&A prompt wearing a new name.
    expect(prompt).not.toContain('intelligent M&A Data Analysis Assistant');
  });

  it('shares the M&A pipeline-operations mechanics with the minority flavor', async () => {
    await getAgentGraph('mna');
    await getAgentGraph('minority');

    const mnaPrompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;
    const minorityPrompt = mocks.createAgent.mock.calls[1][0].systemPrompt as string;

    // Same tools means the same write discipline: no direct writes, handoffs
    // and the inline bulk cards, verbatim in both prompts.
    for (const heading of [
      '## Emailing the User (one email, whatever they asked for)',
      '## Editing a Company Card Section',
      '## Delegating to the Workforce',
      '## Adding a New Company (Chat-Initiated)',
      '## Bulk Drop and Bulk Promote — Inline Approval Cards (Chat-Only)',
      '## Promoting Companies from L0 to L1',
    ]) {
      expect(mnaPrompt).toContain(heading);
      expect(minorityPrompt).toContain(heading);
    }
    expect(minorityPrompt).toContain('**You have NO direct write tools.**');
  });

  it('memoizes the minority flavor independently from mna', async () => {
    const mna = await getAgentGraph('mna');
    const minority = await getAgentGraph('minority');

    expect(minority).not.toBe(mna);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);

    expect(await getAgentGraph('minority')).toBe(minority);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
  });

  // The Crowdfunding flavor: the M&A chat tools plus the five it needs to
  // underwrite a cash flow and a regulated raise rather than an entry multiple.
  it('gives the crowdfunding flavor the mna tools plus its five additions', async () => {
    await getAgentGraph('mna');
    await getAgentGraph('crowdfunding');

    const mnaTools = (mocks.createAgent.mock.calls[0][0].tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    const crowdfundingTools = (
      mocks.createAgent.mock.calls[1][0].tools as Array<{ name: string }>
    ).map((t) => t.name);

    expect(crowdfundingTools.slice(0, mnaTools.length)).toEqual(mnaTools);
    expect(crowdfundingTools.slice(mnaTools.length)).toEqual([
      'calculate_investment_returns',
      'get_regulatory_context',
      'get_company_profile',
      'get_sector_context',
      'valyu_extract_content',
    ]);
    // No tool registered twice — createAgent rejects a duplicate name.
    expect(new Set(crowdfundingTools).size).toBe(crowdfundingTools.length);
  });

  it('builds the crowdfunding flavor with its own small-ticket prompt', async () => {
    await getAgentGraph('crowdfunding');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    expect(prompt).toContain('Crowdfunding Agent');
    // The mandate gate, stated in figures so it can actually be screened on.
    expect(prompt).toContain('## Check the mandate first');
    expect(prompt).toMatch(/around \*\*Rp 10 billion\*\*/);
    expect(prompt).toMatch(/\*\*under Rp 20 billion\*\*/);
    expect(prompt).toMatch(/\*\*outside the mandate\*\*/);
    expect(prompt).toMatch(/\*\*lead with the loss case\*\*/);
    // What is being funded is often part of a company, not the company.
    expect(prompt).toContain('## What exactly is being funded — the perimeter check');
    expect(prompt).toContain('an exposure to the parent dressed as a project');
    // The evidence rule that exists because an MSME's books are corroborated
    // by nothing.
    expect(prompt).toContain('## Verified, Sponsor-stated, Modelled — hard rule');
    expect(prompt).toContain('One source restating itself is still one source.');
    // It is not the M&A prompt wearing a new name.
    expect(prompt).not.toContain('intelligent M&A Data Analysis Assistant');
  });

  it('carries the OJK crowdfunding regime with the instrument behind each parameter', async () => {
    await getAgentGraph('crowdfunding');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    // The current instrument, and the two it revoked — the reason the prompt
    // tells the agent to re-confirm rather than treating these as settled.
    expect(prompt).toContain('POJK 17 Tahun 2025');
    expect(prompt).toContain('POJK 57/POJK.04/2020');
    expect(prompt).toContain('POJK 16/POJK.04/2021');
    expect(prompt).toMatch(/confirm any threshold, cap or window against the current POJK text/i);
    // The cap that makes a sub-Rp 20bn need un-fundable by one issuer alone,
    // and the consequence the agent must apply unprompted.
    expect(prompt).toContain('Rp 10,000,000,000 in any 12-month period');
    expect(prompt).toMatch(/\*\*cannot\*\* be met by a single issuer/);
    // The investor limits, and the perimeter an employee-only raise must stay in.
    expect(prompt).toMatch(/at most \*\*5%\*\*/);
    expect(prompt).toMatch(/at most \*\*10%\*\*/);
    expect(prompt).toContain('**100 parties**');
    expect(prompt).toContain('**50 parties**');
  });

  it('makes an employee-funded raise a compliance question, and refuses individual advice', async () => {
    await getAgentGraph('crowdfunding');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;
    const section = prompt.slice(prompt.indexOf("## Raising from the firm's own employees"));

    expect(section).toMatch(/securities offering before it is an HR exercise/);
    expect(section).toMatch(/voluntary and visibly unlinked to employment/);
    expect(section).toMatch(/default-on payroll deduction/);
    expect(section).toMatch(/legal and compliance for sign-off/);
    expect(section).toMatch(/do \*\*not\*\* tell any individual/);
  });

  it('shares the M&A pipeline-operations mechanics with the crowdfunding flavor', async () => {
    await getAgentGraph('mna');
    await getAgentGraph('crowdfunding');

    const mnaPrompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;
    const crowdfundingPrompt = mocks.createAgent.mock.calls[1][0].systemPrompt as string;

    // It holds every M&A chat tool, so it inherits the same write discipline.
    for (const heading of [
      '## Emailing the User (one email, whatever they asked for)',
      '## Editing a Company Card Section',
      '## Delegating to the Workforce',
      '## Adding a New Company (Chat-Initiated)',
      '## Bulk Drop and Bulk Promote — Inline Approval Cards (Chat-Only)',
      '## Promoting Companies from L0 to L1',
    ]) {
      expect(mnaPrompt).toContain(heading);
      expect(crowdfundingPrompt).toContain(heading);
    }
    expect(crowdfundingPrompt).toContain('**You have NO direct write tools.**');
  });

  it('memoizes the crowdfunding flavor independently from mna', async () => {
    const mna = await getAgentGraph('mna');
    const crowdfunding = await getAgentGraph('crowdfunding');

    expect(crowdfunding).not.toBe(mna);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);

    expect(await getAgentGraph('crowdfunding')).toBe(crowdfunding);
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
  });
});

// The Investment Banking Advisory flavor and the Capital Markets flavor are the
// two advisory-desk flavors: both read the M&A chat surface and add the same
// seven read-only research tools, and both are defined by the job their prompt
// gives them — compare the routes (advisory) versus structure and price the
// instrument (capital markets).
describe('getAgentGraph — advisory desk flavors', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const ADVISORY_ADDITIONS = [
    'calculate_investment_returns',
    'get_company_profile',
    'get_sector_context',
    'get_competitor_landscape',
    'get_regulatory_context',
    'get_market_signals',
    'valyu_extract_content',
  ];

  it.each(['investment_banking', 'capital_markets'] as const)(
    'gives the %s flavor the mna tools plus the seven research additions',
    async (flavor) => {
      await getAgentGraph('mna');
      await getAgentGraph(flavor);

      const mnaTools = (mocks.createAgent.mock.calls[0][0].tools as Array<{ name: string }>).map(
        (t) => t.name,
      );
      const flavorTools = (
        mocks.createAgent.mock.calls[1][0].tools as Array<{ name: string }>
      ).map((t) => t.name);

      expect(flavorTools.slice(0, mnaTools.length)).toEqual(mnaTools);
      expect(flavorTools.slice(mnaTools.length)).toEqual(ADVISORY_ADDITIONS);
      // No tool registered twice — createAgent rejects a duplicate name.
      expect(new Set(flavorTools).size).toBe(flavorTools.length);
    },
  );

  it.each(['investment_banking', 'capital_markets'] as const)(
    'shares the M&A pipeline-operations mechanics with the %s flavor',
    async (flavor) => {
      await getAgentGraph('mna');
      await getAgentGraph(flavor);

      const mnaPrompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;
      const prompt = mocks.createAgent.mock.calls[1][0].systemPrompt as string;

      for (const heading of [
        '## Emailing the User (one email, whatever they asked for)',
        '## Editing a Company Card Section',
        '## Delegating to the Workforce',
        '## Adding a New Company (Chat-Initiated)',
        '## Bulk Drop and Bulk Promote — Inline Approval Cards (Chat-Only)',
        '## Promoting Companies from L0 to L1',
      ]) {
        expect(mnaPrompt).toContain(heading);
        expect(prompt, flavor).toContain(heading);
      }
      expect(prompt, flavor).toContain('**You have NO direct write tools.**');
    },
  );

  it.each(['investment_banking', 'capital_markets'] as const)(
    'memoizes the %s flavor independently from mna',
    async (flavor) => {
      const mna = await getAgentGraph('mna');
      const built = await getAgentGraph(flavor);

      expect(built).not.toBe(mna);
      expect(mocks.createAgent).toHaveBeenCalledTimes(2);

      expect(await getAgentGraph(flavor)).toBe(built);
      expect(mocks.createAgent).toHaveBeenCalledTimes(2);
    },
  );

  it('builds the investment_banking flavor with its own advisory prompt', async () => {
    await getAgentGraph('investment_banking');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    expect(prompt).toContain('Investment Banking Advisory Agent');
    // The deliverable is a comparison, never one route analysed alone.
    expect(prompt).toMatch(
      /The deliverable is a recommendation among alternatives, never a single idea/,
    );
    expect(prompt).toContain('## The route menu');
    // It is not the M&A prompt wearing a new name.
    expect(prompt).not.toContain('intelligent M&A Data Analysis Assistant');
  });

  it('puts every exit route on the investment_banking menu, including doing nothing', async () => {
    await getAgentGraph('investment_banking');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;
    const menu = prompt.slice(
      prompt.indexOf('## The route menu'),
      prompt.indexOf('## How to work a mandate'),
    );

    for (const route of [
      '**Control sale (M&A)**',
      '**Minority / growth stake sale**',
      '**IPO**',
      '**Follow-on / secondary sell-down**',
      '**Bond issuance / debt capital markets**',
      '**Leveraged recapitalisation / dividend recap**',
      '**Strategic partnership / JV / commercial alliance**',
      '**Carve-out / divestiture / spin-off**',
      '**Private placement / pre-IPO round**',
      '**Do nothing, or wait**',
    ]) {
      expect(menu, route).toContain(route);
    }
    // The status-quo baseline is priced, not just listed.
    expect(menu).toMatch(/never names the status-quo baseline is incomplete/);
    // Instrument-level structuring is the capital-markets desk's job.
    expect(menu).toMatch(/this is the \*\*Capital Markets\*\* flavor's territory/);
  });

  it('makes the investment_banking flavor value in ranges and disclose its own conflict', async () => {
    await getAgentGraph('investment_banking');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    expect(prompt).toMatch(/Value with a range and a method, never a number/);
    expect(prompt).toMatch(/a multiple quoted from memory is a guess/);
    // Headline EV is not proceeds.
    expect(prompt).toMatch(/Headline enterprise value is not proceeds/);
    // Advisory fees reward a transaction — say so.
    expect(prompt).toMatch(/Advisory fees reward a completed transaction/);
    expect(prompt).toMatch(/You do not give legal, tax, accounting, audit or regulatory opinions/);
  });

  it('builds the capital_markets flavor with its own DCM/ECM prompt', async () => {
    await getAgentGraph('capital_markets');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    expect(prompt).toContain('Capital Markets Agent');
    expect(prompt).toContain('**Debt Capital Markets (DCM)**');
    expect(prompt).toContain('**Equity Capital Markets (ECM)**');
    expect(prompt).toContain('## The instrument menu');
    expect(prompt).not.toContain('intelligent M&A Data Analysis Assistant');
  });

  it('carries both sides of the capital_markets instrument menu', async () => {
    await getAgentGraph('capital_markets');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;
    const menu = prompt.slice(
      prompt.indexOf('## The instrument menu'),
      prompt.indexOf('## How to work an issuance'),
    );

    for (const instrument of [
      '**Senior unsecured bonds**',
      '**Senior secured / asset-backed notes**',
      '**Sukuk**',
      '**High-yield notes**',
      '**Convertible / exchangeable bonds**',
      '**Perpetual / hybrid / subordinated capital**',
      '**Syndicated, club and bilateral loans**',
      '**Project finance / limited-recourse debt**',
      '**Securitisation / ABS**',
      '**IPO**',
      '**Rights issue**',
      '**Accelerated bookbuild (ABB) / block trade**',
      '**Private placement / PIPE / pre-IPO round**',
    ]) {
      expect(menu, instrument).toContain(instrument);
    }
  });

  it('makes the capital_markets flavor price off evidence and date every market level', async () => {
    await getAgentGraph('capital_markets');

    const prompt = mocks.createAgent.mock.calls[0][0].systemPrompt as string;

    expect(prompt).toMatch(/Price is set by the market, not by the issuer/);
    expect(prompt).toMatch(
      /Never quote a spread, a coupon or an IPO multiple from memory as if it were a market level/,
    );
    // Whether a window is open is a present-tense fact.
    expect(prompt).toMatch(/A window opens and closes/);
    expect(prompt).toMatch(/never an answer from memory/);
    // Internal records hold no market data at all.
    expect(prompt).toMatch(/Internal records carry no market data at all/);
    // Capacity gates the instrument before any pricing work.
    expect(prompt).toMatch(/Capacity is a fact about the issuer, not a preference/);
    expect(prompt).toMatch(/You do not set a price or underwrite/);
  });
});

// The four chat flavors used to carry their own, mutually inconsistent search
// policies — "web search is a fallback for when the DB is empty" in one section
// and "always search for anything market-shaped" in the next — which let the
// agent settle on re-reading internal records. They now share one grounding
// block that makes external research a default step.
describe('external evidence grounding (chat flavors)', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const promptFor = async (flavor: CopilotAgentType) => {
    await getAgentGraph(flavor);
    return mocks.createAgent.mock.calls[0][0].systemPrompt as string;
  };

  const FLAVORS = [
    'mna',
    'investment',
    'combined',
    'vc',
    'minority',
    'crowdfunding',
    'investment_banking',
    'capital_markets',
  ] as const;

  it.each(FLAVORS)('gives the %s flavor the shared grounding section', async (flavor) => {
    const prompt = await promptFor(flavor);

    expect(prompt).toContain('## Grounding: Internal Records and the Outside World');
    // External research is a default step, not a last resort.
    expect(prompt).toMatch(/External research is a default step, not a fallback/);
    expect(prompt).toMatch(/including when the internal record looks complete/);
    // Fire it alongside the internal read rather than after discovering a gap.
    expect(prompt).toMatch(/Search while you pull internal data, not after it/);
  });

  it.each(FLAVORS)('tells the %s flavor not to re-narrate records it already read', async (flavor) => {
    const prompt = await promptFor(flavor);

    expect(prompt).toMatch(/Don't repeat yourself/);
    expect(prompt).toMatch(/something the user doesn't already have/);
    expect(prompt).toMatch(/the new work is almost always external/);
  });

  it.each(FLAVORS)('tells the %s flavor to date internal figures and surface contradictions', async (flavor) => {
    const prompt = await promptFor(flavor);

    expect(prompt).toMatch(/They do not tell you what is true today/);
    expect(prompt).toMatch(/lead with the contradiction and call the record stale/);
    expect(prompt).toMatch(/Never report "not found" or "no data" on the strength of internal tools alone/);
  });

  // Only the flavors built on the M&A tool list (plus combined) carry
  // search_news, so only those prompts may mention the lake.
  it.each([
    'mna',
    'combined',
    'minority',
    'investment_banking',
    'capital_markets',
  ] as const)(
    'treats search_news and the open web as complements in the %s flavor',
    async (flavor) => {
      const prompt = await promptFor(flavor);

      expect(prompt).toMatch(/complements, not a sequence/);
      // An empty lake is an ingest gap, never evidence the event did not happen.
      expect(prompt).toMatch(/means nothing was ingested — never that nothing happened/);
    },
  );

  it.each(['investment', 'vc'] as const)(
    'never names search_news to the %s flavor, which has no such tool',
    async (flavor) => {
      const prompt = await promptFor(flavor);

      expect(prompt).not.toMatch(/search_news/);
      // The rest of the grounding block still applies.
      expect(prompt).toMatch(/External research is a default step, not a fallback/);
      expect(prompt).toMatch(/valyu_search/);
    },
  );

  it.each(FLAVORS)('drops the old fallback-only framing from the %s flavor', async (flavor) => {
    const prompt = await promptFor(flavor);

    // The two headings that carried the contradictory policies are gone, and so
    // is the search_news-before-the-web precedence rule they each restated.
    expect(prompt).not.toMatch(/CRITICAL: Automatic Web Search Fallback/);
    expect(prompt).not.toMatch(/External Search Fallback/);
    expect(prompt).not.toMatch(/Precedence rule for recent market news/);
  });

  it('keeps a single files guidance line in the M&A flavor', async () => {
    const prompt = await promptFor('mna');

    // Four overlapping "always check files first" mandates collapsed into one
    // that also dates what a file says.
    expect(prompt).not.toMatch(/NEVER\*\* assume internal knowledge is complete/);
    expect(prompt.match(/query_files/g)?.length).toBeLessThan(6);
    expect(prompt).toMatch(/what a memo said last year is evidence about last year/);
  });

  it('points the M&A flavor at the bulk cards section that actually follows it', async () => {
    const prompt = await promptFor('mna');

    // The cross-reference used to say "above" while the section sits below it.
    expect(prompt).toContain('see "Bulk Drop and Bulk Promote — Inline Approval Cards" below');
    expect(prompt).not.toMatch(/`propose_bulk_promote_companies`'s sibling/);
  });

  it('makes external evidence the default for the vc flavor rather than a not-found fallback', async () => {
    const prompt = await promptFor('vc');

    expect(prompt).toMatch(/\*\*External Evidence Is The Default:\*\*/);
    expect(prompt).toMatch(/never let a stale internal field stand in for current evidence/);
    expect(prompt).not.toMatch(/Workspace Fallback & External Subjects/);
  });

  // The VC flavor prefers five focused topic tools that no other flavor has, so
  // the shared block must route to them rather than past them.
  it('routes the vc flavor to its topic tools inside the shared grounding block', async () => {
    const prompt = await promptFor('vc');

    expect(prompt).toMatch(
      /The five focused topic tools \(`get_company_profile`[\s\S]*?\) are the first stop/,
    );
    expect(prompt).toMatch(/and the topic-tool routing above/);
  });

  it.each(['mna', 'investment', 'combined'] as const)(
    'does not name the vc-only topic tools to the %s flavor',
    async (flavor) => {
      const prompt = await promptFor(flavor);

      expect(prompt).not.toMatch(/get_sector_context/);
      expect(prompt).not.toMatch(/first stop for the standard diligence dimensions/);
    },
  );

  // "Dynamic tool selection" used to read as a licence to skip research, which
  // contradicted the grounding block injected into the same prompt.
  it('scopes the vc no-rigid-script rule so it does not cancel the grounding block', async () => {
    const prompt = await promptFor('vc');

    expect(prompt).toMatch(/rather than working through a fixed module sequence or evaluation checklist/);
    expect(prompt).toMatch(/What this rules out is a canned diligence script, not research itself/);
    expect(prompt).not.toMatch(/making mandatory tool calls/);
    // The judgment half of the rule survives intact.
    expect(prompt).toMatch(/must not be delegated to a tool/);
  });

  // The promote/drop procedures are explicit enough to override general
  // guidance, so each one has to carry the external check itself.
  it('puts an external check inside the M&A promote and drop procedures', async () => {
    const prompt = await promptFor('mna');

    // Single L0→L1: judge the EBITDA against something newer than the record.
    expect(prompt).toMatch(/Search externally first for anything that post-dates the stored figures/);
    // Bulk promote: verify the shortlist before proposing it.
    expect(prompt).toMatch(/search the shortlist externally before you commit to it/);
    // Bulk drop: several drop signals only exist outside the record.
    expect(prompt).toMatch(/check the names you intend to drop externally/);
  });

  it('stops framing the per-company read as a gap-fill in the M&A flavor', async () => {
    const prompt = await promptFor('mna');

    expect(prompt).toMatch(/both in the same turn, not one as a backstop for the other/);
    // "Governs every read in this list" contradicted the block's own carve-out
    // for pure-bookkeeping questions.
    expect(prompt).not.toMatch(/governs every read in this list/);
  });
});

// The workforce writes judgments into the record (AI Opinions, promotion and
// drop reasons), so a verdict sourced only from stale internal fields is the
// costliest version of the internal-data bias.
describe('workforce prompt evidence rules', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const workforcePrompt = async () => {
    await getWorkforceAgentGraphForEffort('medium');
    return mocks.createAgent.mock.calls[0][0].systemPrompt as string;
  };

  it('requires an external check before any write that embodies a judgment', async () => {
    const prompt = await workforcePrompt();

    expect(prompt).toContain('## Evidence and freshness');
    expect(prompt).toMatch(/search externally, even when the record looks complete/);
    expect(prompt).toMatch(/Do not write a verdict sourced only from internal fields/);
    expect(prompt).toMatch(/When outside evidence contradicts the record, say so in the report/);
  });

  it('makes web_search a required step of forming an AI Opinion', async () => {
    const prompt = await workforcePrompt();

    expect(prompt).toMatch(/before you form a view, every time/);
    expect(prompt).toMatch(/including when the stored fields look complete/);
  });

  it('drops the internal-before-web ordering from the fund AI Opinion flow', async () => {
    const prompt = await workforcePrompt();

    expect(prompt).not.toMatch(/\*\*Before `web_search`\*\*/);
    // The save_fund_ai_opinion blurb sequenced internal-then-web and so
    // contradicted the procedure it points at.
    expect(prompt).not.toMatch(/check internal notes by name first, then web_search/);
    expect(prompt).toMatch(/every time, not only when the internal side is empty/);
    expect(prompt).toMatch(/Do this on every call, not only when the internal side comes up empty/);
    expect(prompt).toMatch(/a mark can lag reality by quarters/);
  });

  it('lets the agent ask the owner (with a recommendation) instead of guessing, refresh runs included', async () => {
    const prompt = await workforcePrompt();

    expect(prompt).not.toMatch(/there is NO interactive user to clarify with/);
    expect(prompt).toMatch(/The one exception is \*\*ask_owner\*\*/);
    expect(prompt).toMatch(/\*\*ask_owner\*\* — pause the run and ask the task's owner ONE question/);
    expect(prompt).toMatch(/call `ask_owner` with your recommended answer instead of guessing/);
  });

  it('treats the news lake and the web as one turn, not a precedence chain', async () => {
    const prompt = await workforcePrompt();

    expect(prompt).toMatch(/complements, not a sequence/);
    expect(prompt).not.toMatch(/call this FIRST, before web_search/);
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

  it.each(['investment', 'combined', 'vc'] as const)(
    'does not strip server tools from the %s flavor when query_fund_sources is removed',
    async (flavor) => {
      await getAgentGraph(flavor, 'medium', false);
      expect(toolNames(0)).not.toContain('query_fund_sources');
      expect(toolNames(0)).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    },
  );

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

describe('AgentGraph withheld tools', () => {
  const toolList = [
    { name: 'query_companies' },
    { name: 'propose_insight_create' },
    { name: 'propose_workforce_handoff' },
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  ] as unknown as ToolList;
  const names = (list: unknown) => (list as Array<{ name: string }>).map((t) => t.name);

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.createAgent.mockClear();
  });

  it('withoutTools drops the named tools, keeps order, and returns the list itself when nothing is withheld', () => {
    expect(names(withoutTools(toolList, ['propose_insight_create', 'not_a_tool']))).toEqual([
      'query_companies',
      'propose_workforce_handoff',
      'web_search',
    ]);
    expect(withoutTools(toolList, [])).toBe(toolList);
    expect(withoutTools(toolList)).toBe(toolList);
  });

  it('builds this turn\'s agent without the withheld tools, and leaves the default agent whole', async () => {
    const graph = new AgentGraph({ apiKey: 'test-key' } as never, toolList, 'PROMPT');
    const defaultTools = names(mocks.createAgent.mock.calls[0][0].tools);

    await graph.streamEvents(
      { messages: [], additionalSystemContext: 'ctx', withheldTools: ['propose_insight_create'] },
      { version: 'v2' },
    );

    expect(defaultTools).toContain('propose_insight_create');
    const turnTools = names(mocks.createAgent.mock.calls.at(-1)![0].tools);
    expect(turnTools).toEqual(['query_companies', 'propose_workforce_handoff', 'web_search']);
  });

  it('keeps every tool on an ordinary turn', async () => {
    const graph = new AgentGraph({ apiKey: 'test-key' } as never, toolList, 'PROMPT');

    await graph.invoke({ messages: [], additionalSystemContext: 'ctx' });

    expect(names(mocks.createAgent.mock.calls.at(-1)![0].tools)).toContain('propose_insight_create');
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

// Builds every agent flavor in turn and hands its createAgent config to `check`.
const AGENT_BUILDERS: Array<[string, () => Promise<unknown>]> = [
  ['mna', () => getAgentGraph('mna')],
  ['investment', () => getAgentGraph('investment')],
  ['combined', () => getAgentGraph('combined')],
  ['vc', () => getAgentGraph('vc')],
  ['workforce', () => getWorkforceAgentGraphForEffort('medium')],
];

async function eachBuiltAgent(check: (config: Record<string, unknown>, flavor: string) => void) {
  for (const [flavor, build] of AGENT_BUILDERS) {
    mocks.createAgent.mockClear();
    await build();
    check(mocks.createAgent.mock.calls[0][0], flavor);
  }
}

type BuiltModel = { opts: Record<string, unknown>; config?: Record<string, unknown> };
const builtModel = () => mocks.createAgent.mock.calls[0][0].model as BuiltModel;

describe('Agent LLM configuration', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('never selects the max effort rung automatically', () => {
    for (const tier of Object.values(EFFORT_TIERS)) {
      expect(tier.effort).not.toBe('max');
    }
  });

  it('leaves every tier room under the route ceiling to wrap up', () => {
    // The route's maxDuration is a build-time constant and cannot vary by tier,
    // so each budget must fire first — with enough slack left for the wrap-up
    // call and for the response to drain. Hitting the platform limit instead
    // discards the whole turn silently.
    for (const [name, tier] of Object.entries(EFFORT_TIERS)) {
      expect(
        CHAT_TURN_BUDGET_CEILING_MS - tier.turnBudgetMs,
        `tier "${name}" leaves too little headroom`,
      ).toBeGreaterThanOrEqual(120_000);
    }
  });

  it('orders the turn budgets by tier', () => {
    const ladder: EffortChoice[] = ['low', 'medium', 'high', 'deep'];
    for (let i = 1; i < ladder.length; i++) {
      expect(EFFORT_TIERS[ladder[i]].turnBudgetMs).toBeGreaterThan(EFFORT_TIERS[ladder[i - 1]].turnBudgetMs);
    }
  });

  it.each<[EffortChoice | undefined, string, string, number]>([
    ['low', 'claude-sonnet-5', 'medium', 16_000],
    ['medium', 'claude-sonnet-5', 'high', 32_000],
    ['high', 'claude-opus-5', 'high', 64_000],
    ['deep', 'claude-opus-5', 'xhigh', 96_000],
    // An omitted tier must stay at today's behaviour, not silently drop.
    [undefined, 'claude-sonnet-5', 'high', 32_000],
  ])('maps tier %s to its model, output effort and output ceiling', (effort, model, outputEffort, maxTokens) => {
    createLocalAgent({ apiKey: 'test-key', ...(effort ? { effort } : {}) });
    const { opts } = builtModel();
    expect(opts.model).toBe(model);
    expect(opts.outputConfig).toEqual({ effort: outputEffort });
    expect(opts.maxTokens).toBe(maxTokens);
  });

  it('stamps the tier into run metadata so traces can report it', async () => {
    const graph = new AgentGraph({ apiKey: 'test-key', effort: 'deep' });
    const agent = mocks.createAgent.mock.results[0].value as {
      streamEvents: ReturnType<typeof vi.fn>;
    };
    await graph.streamEvents({ messages: [] });
    const runConfig = agent.streamEvents.mock.calls[0][1] as {
      metadata: Record<string, string>;
    };
    expect(runConfig.metadata).toMatchObject({
      effort_tier: 'deep',
      effort_model: 'claude-opus-5',
      output_effort: 'xhigh',
    });
  });

  it('escalates but never de-escalates a thread', () => {
    expect(maxEffort('low', 'high')).toBe('high');
    expect(maxEffort('high', 'low')).toBe('high');
    expect(maxEffort('medium', 'medium')).toBe('medium');
    expect(maxEffort('deep', 'high')).toBe('deep');
  });

  it('narrows server-side tier input, accepting deep', () => {
    expect(asEffortChoice('low')).toBe('low');
    expect(asEffortChoice('deep')).toBe('deep');
    expect(asEffortChoice('auto')).toBeNull();
    expect(asEffortChoice('max')).toBeNull();
    expect(asEffortChoice(7)).toBeNull();
  });

  it('rejects deep from request bodies so a client cannot pin the top tier', () => {
    expect(asManualEffort('high')).toBe('high');
    expect(asManualEffort('deep')).toBeNull();
    expect(asManualEffort('max')).toBeNull();
    expect(asManualEffort(null)).toBeNull();
  });

  it('configures ChatAnthropic with adaptive thinking, summarized display, and ephemeral cache_control', () => {
    createLocalAgent({ apiKey: 'test-key' });
    const model = builtModel();
    expect(model.opts.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(model.config?.cache_control).toEqual({ type: 'ephemeral' });
    expect(model.opts.cache_control).toBeUndefined();
    expect(model.opts.streaming).toBe(true);
    expect(model.opts.temperature).toBeUndefined();
  });

  it('enables context editing and beta header on workforce agent graph, but not on chat graphs', async () => {
    await getWorkforceAgentGraphForEffort('medium');
    expect(builtModel().opts.contextManagement).toEqual({
      edits: [{ type: 'clear_tool_uses_20250919' }],
    });
    expect(builtModel().opts.betas).toContain('context-management-2025-06-27');

    for (const build of [() => getAgentGraph('mna'), () => getStatelessAgentGraph()]) {
      mocks.createAgent.mockClear();
      await build();
      expect(builtModel().opts.contextManagement).toBeUndefined();
      expect(builtModel().opts.betas).not.toContain('context-management-2025-06-27');
    }
  });

  it('does not include thinking delimiters in any agent system prompt', async () => {
    const checkPrompt = (prompt: string) => {
      expect(prompt).not.toContain('<!-- THINKING_START -->');
      expect(prompt).not.toContain('<!-- THINKING_END -->');
    };

    await eachBuiltAgent((config) => checkPrompt(config.systemPrompt as string));
  });
});

describe('Anthropic server tools and pause_turn handling', () => {
  beforeEach(() => {
    resetAgent();
    mocks.createAgent.mockClear();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('equips each agent flavor with web_search and web_fetch server tools', async () => {
    await eachBuiltAgent((config, flavor) => {
      const tools = config.tools as Array<{ name: string; type?: string }>;
      expect(tools.find((t) => t.name === 'web_search')?.type, flavor).toBe('web_search_20260209');
      expect(tools.find((t) => t.name === 'web_fetch')?.type, flavor).toBe('web_fetch_20260209');
    });
  });

  it('describes web_search and never mentions web_fetch across all agent system prompts', async () => {
    await eachBuiltAgent((config, flavor) => {
      const prompt = config.systemPrompt as string;
      expect(prompt, `${flavor} should not mention web_fetch`).not.toContain('web_fetch');
      expect(prompt, `${flavor} should describe real results with URLs`).toMatch(/real results with URLs/i);
    });
  });

  describe('pause_turn warning', () => {
    let warnSpy: MockInstance;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    async function statelessGraphWith(agent: { invoke?: unknown; streamEvents?: unknown }) {
      mocks.createAgent.mockReturnValueOnce({
        __agent: true,
        streamEvents: vi.fn(),
        invoke: vi.fn(),
        ...agent,
      } as never);
      const graph = await getStatelessAgentGraph();
      expect(graph).not.toBeNull();
      return graph!;
    }

    async function drain(events: unknown[]) {
      async function* fakeStream() {
        yield* events;
      }
      const graph = await statelessGraphWith({ streamEvents: vi.fn().mockResolvedValue(fakeStream()) });
      const collected: unknown[] = [];
      for await (const event of await graph.streamEvents({ messages: [msg('search query')] })) {
        collected.push(event);
      }
      return collected;
    }

    const metadata = (stop_reason: string) => ({ response_metadata: { stop_reason } });
    const modelEnd = (stop_reason: string) => ({
      event: 'on_chat_model_end',
      data: { output: { content: 'Calling web_search...', ...metadata(stop_reason) } },
    });

    it.each([
      ['pause_turn', 1],
      ['end_turn', 0],
    ])('warns %s-ending invoke turns %i time(s)', async (stopReason, warnings) => {
      const graph = await statelessGraphWith({
        invoke: vi.fn().mockResolvedValue({ messages: [{ content: 'x', ...metadata(stopReason) }] }),
      });

      await graph.invoke({ messages: [msg('trigger search')] });

      expect(warnSpy).toHaveBeenCalledTimes(warnings);
      if (warnings) expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pause_turn'));
    });

    it('passes stream events through and warns once across several pause_turn model-end events', async () => {
      const collected = await drain([
        { event: 'on_chat_model_stream', data: { chunk: { content: 'Calling web_search...' } } },
        modelEnd('pause_turn'),
        modelEnd('pause_turn'),
      ]);

      expect(collected).toHaveLength(3);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pause_turn'));
    });

    it('does not warn on non-model-end events like on_chain_end or on_chat_model_stream', async () => {
      await drain([
        {
          event: 'on_chat_model_stream',
          data: { chunk: { content: 'stream chunk', additional_kwargs: { stop_reason: 'pause_turn' } } },
        },
        {
          event: 'on_chain_end',
          data: { output: { messages: [{ content: 'Interim pause', ...metadata('pause_turn') }] } },
        },
      ]);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
