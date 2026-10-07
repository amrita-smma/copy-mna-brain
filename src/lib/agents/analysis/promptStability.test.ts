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

// Every chat prompt changed on purpose: the AlphaSense subscription is
// retired, so `alphasense_search` is gone from the tool catalogue each flavor
// lists and from the external-research routing guidance (which now points at
// `valyu_search` for filings, transcripts and research).
const EXPECTED_CHAT_HASHES: Record<CopilotAgentType, string> = {
  mna: '9518a17280ea09cd97842ca7bbca5ced764db52074f76cfa13d6a360fec67052',
  investment: 'a663c5e174bc5a7fbb5624d1fa6a45023c556167c4b763f4702afb3f4f0d1330',
  combined: 'cf282feea15ffdc2c8aa332b1c14e55d8c1887b8d9eadaf33d68ed9c0ab902d5',
  vc: '740ff447b50e3b39b00be9519a57ac58210011562d40b906fd77920019b1670e',
  // New flavour: the Minority Stakes Portfolio Manager — the M&A chat tool set
  // under a portfolio-construction prompt (sizing, concentration, minority
  // protections, exit paths).
  minority: 'e0b0037c6b6e925bb09fb2d6ec4fa07ce0f16ebb79e2df2929b8ef3799c127a9',
  // New flavour: the Crowdfunding Agent — the M&A chat tool set plus the
  // returns calculator, regulatory/sector context, company profile and Valyu
  // extraction, under a small-ticket MSME and project-raise prompt (mandate
  // gate, carve-out perimeter, Verified/Sponsor-stated/Modelled, the OJK
  // crowdfunding regime, and the employee-raise conduct rule).
  crowdfunding: '5dbd385cd536f24eef2e4d29449820197fdbd70150951a9194d95d3442acbb16',
  // New flavour: the Investment Banking Advisory Agent — the M&A chat tool set
  // plus the returns calculator, all five topic-research tools and Valyu
  // extraction, under an advisory prompt that compares exit routes (control
  // sale, IPO, bond issuance, recap, partnership, carve-out, do-nothing)
  // rather than underwriting one position.
  investment_banking: '5488c0085baefdb4913daa3904f8f824c07d11c0bebfd9721e99e1e895dd89db',
  // New flavour: the Capital Markets Agent — the same tool set under a DCM/ECM
  // prompt: instrument choice, capacity, structure, evidence-based pricing,
  // investor base, regime and window.
  capital_markets: 'd776e959c3703d176e6cacfc2c3b0f89457cacf04047e9183123b9c57edc1226',
};
// The Workforce prompt changed on purpose, for the same reason: its
// `alphasense_search` read-tool bullet is gone, and the evidence guide no
// longer offers it as the escalation from `web_search` (the workforce tool list
// has no `valyu_search`, so that guidance now stays on `web_search` and
// `search_news`).
const EXPECTED_WORKFORCE_HASH = '68250fab2f0c677553eecd5b5c7ce5687a6eebc6b87515ef13919a89ab0cd7ce';

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

  it('routes a template too large for chat to the Workforce, which reads it in parts', async () => {
    for (const flavor of Object.keys(EXPECTED_CHAT_HASHES) as CopilotAgentType[]) {
      await getAgentGraph(flavor, 'medium');
      expect(lastSystemPrompt(), flavor).toContain('status="too-large-for-chat"');
    }
    await getWorkforceAgentGraphForEffort('medium');
    expect(lastSystemPrompt()).toContain('read EVERY part before you build anything');
  });
});
