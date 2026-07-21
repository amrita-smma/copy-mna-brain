import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getStatelessAgentGraph, extractFirstTurn } = vi.hoisted(() => ({
  getStatelessAgentGraph: vi.fn(),
  extractFirstTurn: vi.fn(),
}));

vi.mock('@/lib/agents/analysis', () => ({
  getStatelessAgentGraph,
  extractFirstTurn,
  // Minimal stub carrying the prompt through as `content`.
  HumanMessage: class {
    content: unknown;
    constructor(content: unknown) {
      this.content = content;
    }
  },
}));

vi.mock('@/lib/workspace', () => ({
  // Run the callback synchronously; the workspace context is a no-op in tests.
  runWithWorkforceWorkspaceId: (_ws: string, fn: () => unknown) => fn(),
}));

import { buildDailyPulsePrompt, generateDailyPulse } from './dailyPulseNarrator';

const NOW = new Date('2026-07-20T12:00:00.000Z');

describe('buildDailyPulsePrompt', () => {
  it('states the today vs prior-day windows with concrete timestamps', () => {
    const prompt = buildDailyPulsePrompt(NOW);
    expect(prompt).toContain('2026-07-20T12:00:00.000Z'); // now
    expect(prompt).toContain('2026-07-19T12:00:00.000Z'); // 24h ago
    expect(prompt).toContain('2026-07-18T12:00:00.000Z'); // 48h ago
    expect(prompt).toContain('TODAY');
    expect(prompt).toContain('PRIOR DAY');
  });

  it('tells the agent to gather data with its own tools', () => {
    const prompt = buildDailyPulsePrompt(NOW);
    expect(prompt).toContain('query_companies');
    expect(prompt).toContain('analyze_stalled_deals');
  });
});

describe('generateDailyPulse', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    getStatelessAgentGraph.mockReset();
    extractFirstTurn.mockReset();
    getStatelessAgentGraph.mockResolvedValue({ invoke });
  });

  afterEach(() => vi.clearAllMocks());

  it('returns the trimmed markdown the Analyst agent produced', async () => {
    invoke.mockResolvedValueOnce({ messages: ['agent-messages'] });
    extractFirstTurn.mockReturnValueOnce({ userText: '', assistantText: '  # Recap\nAll good.  ' });

    const out = await generateDailyPulse(NOW, 'ws-1');

    expect(out).toBe('# Recap\nAll good.');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sends the daily-pulse prompt as the human message', async () => {
    invoke.mockResolvedValueOnce({ messages: [] });
    extractFirstTurn.mockReturnValueOnce({ userText: '', assistantText: 'x' });

    await generateDailyPulse(NOW, 'ws-1');

    const messages = invoke.mock.calls[0][0].messages as Array<{ content: string }>;
    expect(messages[0].content).toContain('Managing Partner');
    expect(messages[0].content).toBe(buildDailyPulsePrompt(NOW));
  });

  it('throws when the Analyst agent is unavailable', async () => {
    getStatelessAgentGraph.mockResolvedValueOnce(null);

    await expect(generateDailyPulse(NOW, 'ws-1')).rejects.toThrow(/unavailable/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('throws when the agent returns no text', async () => {
    invoke.mockResolvedValueOnce({ messages: [] });
    extractFirstTurn.mockReturnValueOnce({ userText: '', assistantText: '   ' });

    await expect(generateDailyPulse(NOW, 'ws-1')).rejects.toThrow(/empty/i);
  });
});
