import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock fns so the module-level vi.mock factories can reference them.
const mocks = vi.hoisted(() => ({
  createAgent: vi.fn((_config: Record<string, unknown>) => ({ __agent: true })),
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
  getStatelessAgentGraph,
  resetAgent,
} from '@/lib/agents/analysis';
import type { BaseMessage } from '@langchain/core/messages';

// Minimal stand-in for a message — extractMessageText only reads `.content`.
const msg = (content: unknown) => ({ content }) as unknown as BaseMessage;

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
