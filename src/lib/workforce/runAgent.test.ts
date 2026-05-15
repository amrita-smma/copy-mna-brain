/**
 * Unit tests for runAgent. Without the WDK compiler the 'use workflow' and
 * 'use step' directives are no-ops, so the function executes top-to-bottom as
 * plain async code. We mock the LangChain agent, the repo, and the DB client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findById,
  heartbeat,
  markSucceeded,
  markFailed,
  createDb,
  invokeMock,
  getWorkforceAgentGraph,
  HumanMessage,
} = vi.hoisted(() => ({
  findById: vi.fn(),
  heartbeat: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
  createDb: vi.fn(),
  invokeMock: vi.fn(),
  getWorkforceAgentGraph: vi.fn(),
  // Identity carrier so tests can assert the argument structure without
  // pulling LangChain types into the test environment.
  HumanMessage: class {
    constructor(public content: string) {}
  },
}));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockAiWorkforceQueueRepository {
    findById = findById;
    heartbeat = heartbeat;
    markSucceeded = markSucceeded;
    markFailed = markFailed;
  }
  return {
    ...actual,
    AiWorkforceQueueRepository: MockAiWorkforceQueueRepository,
  };
});

vi.mock('@/lib/server/db', () => ({ createDb }));

vi.mock('@/lib/agents/analysis', () => ({
  getWorkforceAgentGraph,
  HumanMessage,
}));

import { runAgent } from './runAgent';

const RUN_ID = 'run-1';
const PROMPT = 'Find me Industrial sector companies.';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    status: 'running',
    input: { prompt: PROMPT },
    ...overrides,
  };
}

function makeAgentResult(opts: {
  finalText?: string;
  messages?: Array<{ content: unknown; tool_calls?: unknown[] }>;
} = {}) {
  const messages = opts.messages ?? [
    { content: 'user msg' },
    { content: opts.finalText ?? 'Done.', tool_calls: [] },
  ];
  return { messages };
}

describe('runAgent — happy path', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    findById.mockReset();
    heartbeat.mockReset();
    markSucceeded.mockReset();
    markFailed.mockReset();
    createDb.mockReset().mockReturnValue({});
    invokeMock.mockReset();
    getWorkforceAgentGraph.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('feeds input.prompt through to the agent with runId as thread_id', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    // Agent received exactly one HumanMessage with the row's prompt.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [inputArg, configArg] = invokeMock.mock.calls[0];
    expect(inputArg).toEqual({
      messages: [expect.any(HumanMessage)],
    });
    expect((inputArg as { messages: Array<{ content: string }> }).messages[0].content).toBe(
      PROMPT,
    );
    // Thread id wired from runId so subsequent resumes see the same checkpoint.
    expect(configArg).toEqual(
      expect.objectContaining({ configurable: { thread_id: RUN_ID } }),
    );
  });

  it('persists final message + counts via markSucceeded', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce(
      makeAgentResult({
        messages: [
          { content: 'user msg' },
          { content: 'tool ask', tool_calls: [{ name: 'queryCompanies' }] },
          { content: 'tool result' },
          { content: 'Final answer.', tool_calls: [] },
        ],
      }),
    );

    await runAgent({ runId: RUN_ID });

    expect(heartbeat).toHaveBeenCalledWith(RUN_ID);
    expect(markSucceeded).toHaveBeenCalledTimes(1);
    expect(markSucceeded).toHaveBeenCalledWith(RUN_ID, {
      final_message: 'Final answer.',
      message_count: 4,
      tool_call_count: 1,
    });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('stringifies non-string final content', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce({
      messages: [{ content: { structured: 'response' } }],
    });

    await runAgent({ runId: RUN_ID });

    expect(markSucceeded).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        final_message: JSON.stringify({ structured: 'response' }),
      }),
    );
  });
});

describe('runAgent — guard rails', () => {
  beforeEach(() => {
    findById.mockReset();
    markSucceeded.mockReset();
    markFailed.mockReset().mockResolvedValue({});
    getWorkforceAgentGraph.mockReset();
    invokeMock.mockReset();
    createDb.mockReset().mockReturnValue({});
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('throws FatalError when the row is missing', async () => {
    findById.mockResolvedValueOnce(null);

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow(
      /row run-1 not found/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('throws FatalError when the row is not in running status', async () => {
    findById.mockResolvedValueOnce(makeRow({ status: 'pending' }));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow(
      /status pending, expected 'running'/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('throws FatalError when neither input.prompt nor input.instruction is present', async () => {
    findById.mockResolvedValueOnce(makeRow({ input: { topic: 'X' } }));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow(
      /no usable prompt/,
    );
  });

  it('throws FatalError when input.prompt is empty string and no instruction', async () => {
    findById.mockResolvedValueOnce(makeRow({ input: { prompt: '   ' } }));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow(
      /no usable prompt/,
    );
  });

  it('falls back to input.instruction when input.prompt is missing (MB-151 handoff shape)', async () => {
    findById.mockResolvedValueOnce(
      makeRow({
        input: {
          title: 'Promote Cinder Foods',
          instruction: 'Promote Cinder Foods from L0 to L1.',
        },
      }),
    );
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [inputArg] = invokeMock.mock.calls[0];
    expect(
      (inputArg as { messages: Array<{ content: string }> }).messages[0]
        .content,
    ).toBe('Promote Cinder Foods from L0 to L1.');
  });

  it('prefers input.prompt over input.instruction when both are present', async () => {
    findById.mockResolvedValueOnce(
      makeRow({
        input: {
          prompt: 'Use this prompt',
          instruction: 'Use this instruction instead',
        },
      }),
    );
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce(makeAgentResult());

    await runAgent({ runId: RUN_ID });

    const [inputArg] = invokeMock.mock.calls[0];
    expect(
      (inputArg as { messages: Array<{ content: string }> }).messages[0]
        .content,
    ).toBe('Use this prompt');
  });

  it('throws FatalError when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    findById.mockResolvedValueOnce(makeRow());

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow(
      /ANTHROPIC_API_KEY is not set/,
    );
  });
});

describe('runAgent — failure path', () => {
  beforeEach(() => {
    findById.mockReset();
    markSucceeded.mockReset();
    markFailed.mockReset().mockResolvedValue({});
    getWorkforceAgentGraph.mockReset();
    invokeMock.mockReset();
    createDb.mockReset().mockReturnValue({});
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('calls markFailed with the error message and re-throws when invoke fails', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockRejectedValueOnce(new Error('LLM unreachable'));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow('LLM unreachable');

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(RUN_ID, {
      code: 'agent_execution_failed',
      message: 'LLM unreachable',
    });
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('throws RetryableError when getWorkforceAgentGraph returns null', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce(null);

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow(
      /agent graph unavailable/,
    );
    // The "graph unavailable" error still flows through markFailed because
    // the workflow's try/catch wraps invokeAgent.
    expect(markFailed).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ code: 'agent_execution_failed' }),
    );
  });
});

