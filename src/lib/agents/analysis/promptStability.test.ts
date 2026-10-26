import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guards the general CoPilot and Workforce prompts against accidental edits.
 *
 * The sector agents (src/lib/agents/sector) reuse fragments of these prompts,
 * and extracting a fragment into a shared constant must not change a single
 * byte of the prompt the existing agents send. If you change one of these
 * prompts ON PURPOSE, update its hash here in the same commit.
 */

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn((_config: Record<string, unknown>) => ({
    streamEvents: vi.fn(),
    invoke: vi.fn(),
  })),
}));


/**
 * `createAgent` now receives the prompt as a SystemMessage whose first block is
 * the fixed text (with the prompt-cache breakpoint); these tests assert on that
 * text, so the mock records it as the plain string it used to be.
 */
function promptText(systemPrompt: unknown): unknown {
  if (typeof systemPrompt === 'string') return systemPrompt;
  const content = (systemPrompt as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map((b: { text?: string }) => b.text ?? '').join('');
  }
  return systemPrompt;
}

vi.mock('langchain', () => ({
  createAgent: (config: Record<string, unknown>) =>
    mocks.createAgent({ ...config, systemPrompt: promptText(config.systemPrompt) }),
  humanInTheLoopMiddleware: vi.fn(() => ({ __middleware: true })),
  dynamicSystemPromptMiddleware: vi.fn(() => ({ __dynamicSystemPrompt: true })),
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(public opts: Record<string, unknown>) {}
    withConfig() {
      return {};
    }
  },
}));

vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: class {
    setup = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@/lib/agents/analysis/tools', () => ({
  SERVER_TOOLS: [],
  tools: [],
  chatOnlyTools: [],
  workforceOnlyTools: [],
  investmentTools: [],
  combinedTools: [],
  vcTools: [],
  valyuSearch: { name: 'valyu_search' },
  calculateInvestmentReturns: { name: 'calculate_investment_returns' },
  financialEquityAnalysis: { name: 'financial_equity_analysis' },
  getCompanyProfile: { name: 'get_company_profile' },
  getCompetitorLandscape: { name: 'get_competitor_landscape' },
  getMarketSignals: { name: 'get_market_signals' },
  getRegulatoryContext: { name: 'get_regulatory_context' },
  getSectorContext: { name: 'get_sector_context' },
  valyuExtractContent: { name: 'valyu_extract_content' },
}));

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
  INSIGHT_SOURCES_GUIDE,
  INSIGHT_UNAVAILABLE_GUIDE,
  WORKFORCE_SOURCES_WRITE_ORDER,
} from '@/lib/agents/sector/evidenceMarkers';
import {
  INSIGHT_TEMPLATE_AUTHORING_GUIDE,
  getAgentGraph,
  getWorkforceAgentGraphForEffort,
  resetAgent,
  type CopilotAgentType,
} from '@/lib/agents/analysis';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function lastSystemPrompt(): string {
  const calls = mocks.createAgent.mock.calls;
  return (calls[calls.length - 1]?.[0] as { systemPrompt: string }).systemPrompt;
}

// Every chat prompt changed on purpose: the flavors are now research-biased.
// The shared grounding guide (buildExternalEvidenceGuide) frames the internal
// record as a guideline and research as the default mode — a detected company
// means an external search in that same turn — which moves every chat flavor
// at once. It now also carries a web_search mechanics-and-recovery paragraph:
// the tool is always available, an invalid_tool_input error indicts one call's
// arguments rather than the tool, and empty-input calls shown in a pre-patch
// thread's history are a recording artifact, never a pattern to imitate. The
// search_news tool is gone — recent-news questions go to web_search, run
// aggressively from several angles — so every flavor's tool list and the
// grounding guide's news guidance changed with it. That guide now also carries
// the per-company freshness mandate: every company that surfaces in a turn —
// typed by the user, carried by an attachment, returned by an internal tool, or
// about to be written into the answer — owes a web_search for its latest news
// in that same turn, with further angles on the ones the answer turns on and a
// bound so a fifty-row table does not owe fifty searches. The
// mna prompt additionally changed identity: an M&A Specialist with a "Default
// Posture: Research First" section, not a data-analysis assistant. The
// web_search mechanics paragraph then changed again on purpose, moving every
// chat flavor at once: the tools now carry allowed_callers including "direct",
// so the guide tells the model to call web_search directly as an ordinary tool
// call, reserving code execution for filtering many results — not as the only
// route to a search. Every chat flavor then changed on purpose
// once more, through that same shared guide: it now ends with
// EXTERNAL_RESEARCH_SECTION_GUIDE, which makes the research visible by closing
// every answer with a "## External Research" section — one bullet per external
// call, or the single "None — answered from internal records only." line when
// the turn took the firm's-own-bookkeeping exemption. That section was then
// removed on purpose (users found it noisy), moving every chat flavor again.
// Then the grounding guide itself — the dedicated external research section —
// was removed on purpose, and NEXT_ACTION_GUIDE ("## Offer the Next Action")
// took its place: every chat flavor now closes an answer that leaves an
// action open with one short follow-up question offering that action. Each
// flavor's own prompt still says when to search.
const EXPECTED_CHAT_HASHES: Record<CopilotAgentType, string> = {
  mna: '794718b4ce4af552f487a921fa580c853941dca5971c23cdaf6adfd148349192',
  investment: '4455e9ff3257818b5987a4d659c977fd686727cd807e72df5cc481866159b14a',
  combined: 'ba61e40e31b27e81a87747411641cb5bf26908b8a7b1debcc522a7e003bd9162',
  vc: '9d938807fd4dba1ba15bebe7642dc0af85b27a8341b5457a97fcef645b9d0061',
  // The Minority Stakes Portfolio Manager — a portfolio-construction prompt
  // (sizing, concentration, minority protections, exit paths) over the M&A
  // chat tool set plus `financial_equity_analysis`.
  minority: 'da9029be8715b7452ec2cfc7a535bacb4809ae195457f9528170f33cb2f83239',
  // The Crowdfunding Agent — the M&A chat tool set plus the returns
  // calculator, regulatory/sector context, company profile and Valyu
  // extraction, under a small-ticket MSME and project-raise prompt (mandate
  // gate, carve-out perimeter, Verified/Sponsor-stated/Modelled, the OJK
  // crowdfunding regime, and the employee-raise conduct rule).
  crowdfunding: '2b84bc77d406e79130a1ee40cdc3af4eeb78fa84a88a682a4e60b20149fab949',
  // The Investment Banking Advisory Agent — the M&A chat tool set plus the
  // returns calculator, all five topic-research tools and Valyu extraction,
  // under an advisory prompt that compares exit routes (control sale, IPO,
  // bond issuance, recap, partnership, carve-out, do-nothing) rather than
  // underwriting one position.
  investment_banking: 'a62b5a564f786b9f69d0585cefcd7fa82ec2ff8006cafb57d01190cc9f6ad2ee',
  // The Capital Markets Agent — the same tool set under a DCM/ECM prompt:
  // instrument choice, capacity, structure, evidence-based pricing, investor
  // base, regime and window.
  capital_markets: 'f7ffb5eb00ac49ad9629f1946a863cc8a13b4e0c1239b9f8daae6a26e69509b5',
};
// The Workforce prompt changed on purpose: the hardcoded promote_to_l0 /
// promote_to_l1 pair is replaced by lookup_pipeline_stage + move_stage, which
// walk the workspace's stage ladder (Pending Confirmation, then its live
// stages) one step at a time and gate any move touching L1+.
const EXPECTED_WORKFORCE_HASH = '4498b7ad30df44ba9f876467afc778860e131fec39238935d4c9244b9b5d6d1c';

describe('existing CoPilot prompts', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    resetAgent();
    mocks.createAgent.mockClear();
  });

  for (const flavor of Object.keys(EXPECTED_CHAT_HASHES) as CopilotAgentType[]) {
    it(`keeps the ${flavor} chat prompt byte-identical`, async () => {
      await getAgentGraph(flavor, 'medium');
      expect(sha256(lastSystemPrompt())).toBe(EXPECTED_CHAT_HASHES[flavor]);
    });
  }

  it('keeps the workforce prompt byte-identical', async () => {
    await getWorkforceAgentGraphForEffort('medium');
    expect(sha256(lastSystemPrompt())).toBe(EXPECTED_WORKFORCE_HASH);
  });

  it('teaches Sources and unavailable cells in every chat prompt and the workforce prompt (MB-551, MB-556)', async () => {
    for (const flavor of Object.keys(EXPECTED_CHAT_HASHES) as CopilotAgentType[]) {
      await getAgentGraph(flavor, 'medium');
      const prompt = lastSystemPrompt();
      expect(prompt, flavor).toContain(INSIGHT_SOURCES_GUIDE);
      expect(prompt, flavor).toContain(INSIGHT_UNAVAILABLE_GUIDE);
      expect(prompt, flavor).not.toContain(WORKFORCE_SOURCES_WRITE_ORDER);
    }
    await getWorkforceAgentGraphForEffort('medium');
    const workforce = lastSystemPrompt();
    expect(workforce).toContain(INSIGHT_SOURCES_GUIDE);
    expect(workforce).toContain(WORKFORCE_SOURCES_WRITE_ORDER);
    expect(workforce).toContain(INSIGHT_UNAVAILABLE_GUIDE);
  });

  it('points template requests at the template UI in every chat prompt and not in the workforce prompt', async () => {
    for (const flavor of Object.keys(EXPECTED_CHAT_HASHES) as CopilotAgentType[]) {
      await getAgentGraph(flavor, 'medium');
      expect(lastSystemPrompt(), flavor).toContain(INSIGHT_TEMPLATE_AUTHORING_GUIDE);
    }
    expect(INSIGHT_TEMPLATE_AUTHORING_GUIDE).toContain('Upload Template');
    expect(INSIGHT_TEMPLATE_AUTHORING_GUIDE).toContain('Save as template');
    await getWorkforceAgentGraphForEffort('medium');
    expect(lastSystemPrompt()).not.toContain(INSIGHT_TEMPLATE_AUTHORING_GUIDE);
  });

  it('tells the workforce a missing investment mandate is not a negative signal', async () => {
    await getWorkforceAgentGraphForEffort('medium');
    const workforce = lastSystemPrompt();
    expect(workforce).toContain('**If no active mandate is configured**');
    expect(workforce).toContain('entirely normal and NOT a negative signal');
    expect(workforce).toContain('judge the company on the data you do have');
    expect(workforce).toContain(
      'Never soften, delay or withhold a verdict because no mandate exists.',
    );
  });

  it('routes a template too large for chat to the Workforce, which reads it in parts', async () => {
    for (const flavor of Object.keys(EXPECTED_CHAT_HASHES) as CopilotAgentType[]) {
      await getAgentGraph(flavor, 'medium');
      expect(lastSystemPrompt(), flavor).toContain('status="too-large-for-chat"');
    }
    await getWorkforceAgentGraphForEffort('medium');
    expect(lastSystemPrompt()).toContain('read EVERY part before you build anything');
  });
});
