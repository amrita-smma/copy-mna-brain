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

vi.mock('langchain', () => ({
  createAgent: mocks.createAgent,
  humanInTheLoopMiddleware: vi.fn(() => ({ __middleware: true })),
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
// at once. The mna prompt additionally changed identity: an M&A Specialist
// with a "Default Posture: Research First" section, not a data-analysis
// assistant.
const EXPECTED_CHAT_HASHES: Record<CopilotAgentType, string> = {
  mna: '6545645a89695ce365f481662abafbac1df20ce810fc50692af90b1ecd4b96e0',
  investment: 'a7bff6803334bd968e5cb5d94859057d8eacb043a3c93c0034251bd548299458',
  combined: '74782a7f1afcd6c6afdb07aa3647f66c537246d45a4794bb8db2cba451581be9',
  vc: '4736949d6ac25e2ede95b9cf03847fed2617f4c1a3656c0cb8081145ff29e038',
  // The Minority Stakes Portfolio Manager — a portfolio-construction prompt
  // (sizing, concentration, minority protections, exit paths) over the M&A
  // chat tool set plus `financial_equity_analysis`.
  minority: '44b972ab0a87c6cf2ff2eaca3137c23290fc72d27fb6a06f31f8b12fc04668b0',
  // The Crowdfunding Agent — the M&A chat tool set plus the returns
  // calculator, regulatory/sector context, company profile and Valyu
  // extraction, under a small-ticket MSME and project-raise prompt (mandate
  // gate, carve-out perimeter, Verified/Sponsor-stated/Modelled, the OJK
  // crowdfunding regime, and the employee-raise conduct rule).
  crowdfunding: '0924e03eeb32d4a1c469a6034a3ec13cd65a3298a729b145d144ce40835a76d2',
  // The Investment Banking Advisory Agent — the M&A chat tool set plus the
  // returns calculator, all five topic-research tools and Valyu extraction,
  // under an advisory prompt that compares exit routes (control sale, IPO,
  // bond issuance, recap, partnership, carve-out, do-nothing) rather than
  // underwriting one position.
  investment_banking: 'f6cf192fcad08fc6612e9020e6bf7fc0e2c27fb52acd94c5eb6a2f619d5b5b45',
  // The Capital Markets Agent — the same tool set under a DCM/ECM prompt:
  // instrument choice, capacity, structure, evidence-based pricing, investor
  // base, regime and window.
  capital_markets: '57b7123d5a20d2c1caf663989a46aef843ae533ed070d83a25018f401a6939bb',
};
// The Workforce prompt changed on purpose: the mandate-fit step of "Forming an
// AI Opinion" now says what to do when the workspace has no active mandate —
// drop the dimension, don't flag its absence, and judge the company on the data
// that does exist rather than softening or withholding the verdict.
const EXPECTED_WORKFORCE_HASH = '3300ffa37b2b7dcdf6b434be9bd1ab3b4a0d4b854cc11ab5a03988e079d26093';

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
