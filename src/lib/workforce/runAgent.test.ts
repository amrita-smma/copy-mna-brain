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
  markWaitingForHumanInput,
  clearResumeToken,
  consumePendingUserMessages,
  createDb,
  invokeMock,
  resumeMock,
  getWorkforceAgentGraph,
  dispatcherTick,
  HumanMessage,
} = vi.hoisted(() => ({
  findById: vi.fn(),
  heartbeat: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
  markWaitingForHumanInput: vi.fn(),
  clearResumeToken: vi.fn(),
  consumePendingUserMessages: vi.fn(),
  createDb: vi.fn(),
  invokeMock: vi.fn(),
  resumeMock: vi.fn(),
  getWorkforceAgentGraph: vi.fn(),
  dispatcherTick: vi.fn(),
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
    markWaitingForHumanInput = markWaitingForHumanInput;
    clearResumeToken = clearResumeToken;
    consumePendingUserMessages = consumePendingUserMessages;
  }
  return {
    ...actual,
    AiWorkforceQueueRepository: MockAiWorkforceQueueRepository,
  };
});

vi.mock('@/lib/server/db', () => ({ createDb, withBackgroundDb: vi.fn(async (cb) => cb(createDb())) }));

vi.mock('@/lib/agents/analysis', () => ({
  getWorkforceAgentGraph,
  getWorkforceAgentGraphForEffort: getWorkforceAgentGraph,
  HumanMessage,
  // Faithful copy of the real helper (a pure function) so we don't pull the
  // heavy tools/db deps the rest of this mock avoids.
  extractMessageText: (message: { content?: unknown } | undefined): string => {
    if (!message) return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === 'string') return block;
          if (
            block &&
            typeof block === 'object' &&
            'text' in block &&
            typeof (block as { text: unknown }).text === 'string'
          ) {
            return (block as { text: string }).text;
          }
          return '';
        })
        .join('');
    }
    return '';
  },
}));

vi.mock('./dispatcher', () => ({ dispatcherTick }));

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
    markWaitingForHumanInput.mockReset();
    clearResumeToken.mockReset();
    consumePendingUserMessages.mockReset().mockResolvedValue([]);
    createDb.mockReset().mockReturnValue({});
    invokeMock.mockReset();
    resumeMock.mockReset();
    getWorkforceAgentGraph.mockReset();
    dispatcherTick.mockReset().mockResolvedValue({ outcome: 'empty' });
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

  it('extracts text from array content-block final content', async () => {
    // @langchain/anthropic returns a tool-using agent's final content as an
    // array of content blocks. The report must be the text, not a
    // JSON.stringify'd block wrapper.
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce({
      messages: [
        {
          content: [{ type: 'text', text: '✓ Done: promoted 3 companies.' }],
        },
      ],
    });

    await runAgent({ runId: RUN_ID });

    expect(markSucceeded).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        final_message: '✓ Done: promoted 3 companies.',
      }),
    );
  });
});

describe('runAgent — guard rails', () => {
  beforeEach(() => {
    findById.mockReset();
    markSucceeded.mockReset();
    markFailed.mockReset().mockResolvedValue({});
    markWaitingForHumanInput.mockReset();
    clearResumeToken.mockReset();
    consumePendingUserMessages.mockReset().mockResolvedValue([]);
    getWorkforceAgentGraph.mockReset();
    invokeMock.mockReset();
    resumeMock.mockReset();
    createDb.mockReset().mockReturnValue({});
    dispatcherTick.mockReset().mockResolvedValue({ outcome: 'empty' });
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
    markWaitingForHumanInput.mockReset();
    clearResumeToken.mockReset();
    consumePendingUserMessages.mockReset().mockResolvedValue([]);
    getWorkforceAgentGraph.mockReset();
    invokeMock.mockReset();
    resumeMock.mockReset();
    createDb.mockReset().mockReturnValue({});
    dispatcherTick.mockReset().mockResolvedValue({ outcome: 'empty' });
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

describe('runAgent — resume branch (rows carrying a resume_token)', () => {
  beforeEach(() => {
    findById.mockReset();
    heartbeat.mockReset();
    markSucceeded.mockReset();
    markFailed.mockReset().mockResolvedValue({});
    markWaitingForHumanInput.mockReset();
    clearResumeToken.mockReset();
    consumePendingUserMessages.mockReset().mockResolvedValue([]);
    getWorkforceAgentGraph.mockReset();
    invokeMock.mockReset();
    resumeMock.mockReset();
    createDb.mockReset().mockReturnValue({});
    dispatcherTick.mockReset().mockResolvedValue({ outcome: 'empty' });
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('calls graph.resume with the parsed payload (and not graph.invoke) when resume_token is present', async () => {
    const payload = { decisions: [{ type: 'approve' }] };
    findById.mockResolvedValueOnce(
      makeRow({ resume_token: JSON.stringify(payload) }),
    );
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    resumeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Resumed.' }));

    await runAgent({ runId: RUN_ID });

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledWith(RUN_ID, payload);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });

  it('uses graph.invoke (not resume) when resume_token is null', async () => {
    findById.mockResolvedValueOnce(makeRow({ resume_token: null }));
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('clears resume_token before persisting the terminal status', async () => {
    findById.mockResolvedValueOnce(
      makeRow({ resume_token: '{"decisions":[{"type":"approve"}]}' }),
    );
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    resumeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    expect(clearResumeToken).toHaveBeenCalledWith(RUN_ID);
    // clearResumeToken must run before markSucceeded so the row's terminal
    // snapshot doesn't carry a stale payload.
    const clearOrder = clearResumeToken.mock.invocationCallOrder[0];
    const succeededOrder = markSucceeded.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(succeededOrder);
  });
});

describe('runAgent — HITL interrupt path', () => {
  beforeEach(() => {
    findById.mockReset();
    heartbeat.mockReset();
    markSucceeded.mockReset();
    markFailed.mockReset().mockResolvedValue({});
    markWaitingForHumanInput.mockReset();
    clearResumeToken.mockReset();
    consumePendingUserMessages.mockReset().mockResolvedValue([]);
    getWorkforceAgentGraph.mockReset();
    invokeMock.mockReset();
    resumeMock.mockReset();
    createDb.mockReset().mockReturnValue({});
    dispatcherTick.mockReset().mockResolvedValue({ outcome: 'empty' });
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('transitions to waiting_for_human_input when the agent returns an interrupt', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    invokeMock.mockResolvedValueOnce({
      messages: [{ content: 'paused mid-tool' }],
      interrupt: {
        actionRequests: [
          {
            name: 'promote_l0_to_l1',
            args: {},
            description: 'Approve promotion of Acme Corp?',
          },
        ],
      },
    });

    await runAgent({ runId: RUN_ID });

    expect(markWaitingForHumanInput).toHaveBeenCalledWith(
      RUN_ID,
      'Approve promotion of Acme Corp?',
    );
    expect(markSucceeded).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });
});

describe('runAgent — reactive dispatcher kick', () => {
  beforeEach(() => {
    findById.mockReset();
    heartbeat.mockReset();
    markSucceeded.mockReset();
    markFailed.mockReset().mockResolvedValue({});
    markWaitingForHumanInput.mockReset();
    clearResumeToken.mockReset();
    consumePendingUserMessages.mockReset().mockResolvedValue([]);
    getWorkforceAgentGraph.mockReset();
    invokeMock.mockReset();
    resumeMock.mockReset();
    createDb.mockReset().mockReturnValue({});
    dispatcherTick.mockReset().mockResolvedValue({ outcome: 'empty' });
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('kicks the dispatcher after markSucceeded on the happy path', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    expect(dispatcherTick).toHaveBeenCalledTimes(1);
    const succeededOrder = markSucceeded.mock.invocationCallOrder[0];
    const dispatchOrder = dispatcherTick.mock.invocationCallOrder[0];
    expect(succeededOrder).toBeLessThan(dispatchOrder);
  });

  it('kicks the dispatcher after markWaitingForHumanInput when the agent pauses', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    invokeMock.mockResolvedValueOnce({
      messages: [],
      interrupt: {
        actionRequests: [{ name: 'tool', args: {}, description: 'pause' }],
      },
    });

    await runAgent({ runId: RUN_ID });

    expect(dispatcherTick).toHaveBeenCalledTimes(1);
  });

  it('kicks the dispatcher after markFailed when the agent throws', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    invokeMock.mockRejectedValueOnce(new Error('LLM unreachable'));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow('LLM unreachable');

    expect(dispatcherTick).toHaveBeenCalledTimes(1);
  });

  it('does not let a dispatcher kick failure bubble out of runAgent', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));
    dispatcherTick.mockRejectedValueOnce(new Error('dispatcher boom'));

    // Errors from the dispatcher kick are swallowed — the cron is the
    // liveness fallback, and we don't want a tick failure to mark a
    // successful run as failed.
    await expect(runAgent({ runId: RUN_ID })).resolves.toBeUndefined();
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });
});

describe('runAgent — pending user messages', () => {
  beforeEach(() => {
    findById.mockReset();
    heartbeat.mockReset();
    markSucceeded.mockReset();
    markFailed.mockReset().mockResolvedValue({});
    markWaitingForHumanInput.mockReset();
    clearResumeToken.mockReset();
    consumePendingUserMessages.mockReset().mockResolvedValue([]);
    getWorkforceAgentGraph.mockReset();
    invokeMock.mockReset();
    resumeMock.mockReset();
    createDb.mockReset().mockReturnValue({});
    dispatcherTick.mockReset().mockResolvedValue({ outcome: 'empty' });
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('appends pending messages onto the initial invoke', async () => {
    findById.mockResolvedValueOnce(makeRow());
    consumePendingUserMessages.mockResolvedValueOnce([
      {
        id: 'm1',
        text: 'also include Acme',
        submitted_at: 't',
        submitted_by_user_id: 'u1',
      },
      {
        id: 'm2',
        text: 'and Beta Co',
        submitted_at: 't',
        submitted_by_user_id: 'u1',
      },
    ]);
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [inputArg] = invokeMock.mock.calls[0];
    const msgs = (inputArg as { messages: Array<{ content: string }> })
      .messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe(PROMPT);
    expect(msgs[1].content).toBe('also include Acme');
    expect(msgs[2].content).toBe('and Beta Co');
  });

  it('uses follow_up_thread_id as the thread_id when present', async () => {
    findById.mockResolvedValueOnce(
      makeRow({
        input: {
          prompt: 'do a follow-up',
          follow_up_thread_id: 'original-run-99',
        },
      }),
    );
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    const [, configArg] = invokeMock.mock.calls[0];
    expect(configArg).toEqual(
      expect.objectContaining({
        configurable: { thread_id: 'original-run-99' },
      }),
    );
  });

  it('on resume, drains pending messages via a follow-up invoke on the same thread', async () => {
    const payload = { decisions: [{ type: 'approve' }] };
    findById.mockResolvedValueOnce(
      makeRow({ resume_token: JSON.stringify(payload) }),
    );
    consumePendingUserMessages.mockResolvedValueOnce([
      {
        id: 'm1',
        text: 'one more thing',
        submitted_at: 't',
        submitted_by_user_id: 'u1',
      },
    ]);
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    // First call: resume returns a non-interrupted result.
    resumeMock.mockResolvedValueOnce(
      makeAgentResult({ finalText: 'Resumed.' }),
    );
    // Second call (follow-up invoke for pending messages): final answer.
    invokeMock.mockResolvedValueOnce(
      makeAgentResult({ finalText: 'Done with update.' }),
    );

    await runAgent({ runId: RUN_ID });

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [inputArg, configArg] = invokeMock.mock.calls[0];
    const msgs = (inputArg as { messages: Array<{ content: string }> })
      .messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('one more thing');
    expect(configArg).toEqual(
      expect.objectContaining({ configurable: { thread_id: RUN_ID } }),
    );
    expect(markSucceeded).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ final_message: 'Done with update.' }),
    );
  });

  it('on resume with no pending messages, does NOT make a follow-up invoke', async () => {
    const payload = { decisions: [{ type: 'approve' }] };
    findById.mockResolvedValueOnce(
      makeRow({ resume_token: JSON.stringify(payload) }),
    );
    consumePendingUserMessages.mockResolvedValueOnce([]);
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      resume: resumeMock,
    });
    resumeMock.mockResolvedValueOnce(
      makeAgentResult({ finalText: 'Resumed.' }),
    );

    await runAgent({ runId: RUN_ID });

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
