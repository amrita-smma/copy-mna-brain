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
  failAiOpinionIfStillProcessingMock,
  prepareForMessageMock,
  deleteFromAnthropicMock,
  publishRunDraftMock,
  notifyInsightRefreshedMock,
  getSectorAgentGraphMock,
} = vi.hoisted(() => ({
  getSectorAgentGraphMock: vi.fn(),
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
  failAiOpinionIfStillProcessingMock: vi.fn(),
  prepareForMessageMock: vi.fn(),
  deleteFromAnthropicMock: vi.fn(),
  publishRunDraftMock: vi.fn(),
  notifyInsightRefreshedMock: vi.fn(),
  // Identity carrier so tests can assert the argument structure without
  // pulling LangChain types into the test environment.
  HumanMessage: class {
    content: unknown;
    constructor(fields: unknown) {
      if (typeof fields === 'string') {
        this.content = fields;
      } else if (fields && typeof fields === 'object' && 'content' in fields) {
        this.content = (fields as { content: unknown }).content;
      } else {
        this.content = fields;
      }
    }
  },
}));

const { getStepMetadataMock } = vi.hoisted(() => ({ getStepMetadataMock: vi.fn() }));
const { resolveRecipientMock, notifyTaskWaitingApprovalMock } = vi.hoisted(() => ({
  resolveRecipientMock: vi.fn(),
  notifyTaskWaitingApprovalMock: vi.fn(),
}));

vi.mock('@/lib/services/interventionRecipientService', () => {
  class MockInterventionRecipientService {
    resolveRecipient = resolveRecipientMock;
  }
  return { InterventionRecipientService: MockInterventionRecipientService };
});
vi.mock('workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('workflow')>()),
  getStepMetadata: getStepMetadataMock,
}));

vi.mock('@/lib/services/chatAttachmentService', () => {
  class MockChatAttachmentService {
    constructor(public workspaceId: string) {}
    prepareForMessage = prepareForMessageMock;
    deleteFromAnthropic = deleteFromAnthropicMock;
  }
  return {
    ChatAttachmentService: MockChatAttachmentService,
  };
});

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
  class MockUserRepository {
    findById = vi.fn().mockResolvedValue(null);
  }
  class MockInsightRepository {}
  class MockInsightVersionRepository {}
  class MockInsightRunDraftRepository {}
  return {
    ...actual,
    AiWorkforceQueueRepository: MockAiWorkforceQueueRepository,
    UserRepository: MockUserRepository,
    InsightRepository: MockInsightRepository,
    InsightVersionRepository: MockInsightVersionRepository,
    InsightRunDraftRepository: MockInsightRunDraftRepository,
  };
});

vi.mock('@/lib/services/insightService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/insightService')>();
  class MockInsightService {
    publishRunDraft = publishRunDraftMock;
  }
  return {
    ...actual,
    InsightService: MockInsightService,
  };
});

vi.mock('@/lib/services/emailNotificationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/emailNotificationService')>();
  class MockEmailNotificationService {
    notifyTaskCompleted = vi.fn().mockResolvedValue(true);
    notifyTaskFailed = vi.fn().mockResolvedValue(true);
    notifyTaskWaitingApproval = notifyTaskWaitingApprovalMock;
    notifyInsightRefreshed = notifyInsightRefreshedMock;
  }
  return {
    ...actual,
    EmailNotificationService: MockEmailNotificationService,
  };
});

vi.mock('@/lib/server/db', () => ({ createDb, withBackgroundDb: vi.fn(async (cb) => cb(createDb())) }));

vi.mock('@/lib/agents/analysis', () => ({
  getWorkforceAgentGraph,
  getWorkforceAgentGraphForEffort: getWorkforceAgentGraph,
  HumanMessage,
  // Minimal stand-in for the real (pure) helper, which lives in a module whose
  // heavy tools/db deps this mock avoids.
  extractMessageText: (message: { content?: unknown } | undefined): string => {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('');
  },
}));

vi.mock('@/lib/agents/sector/graph', () => ({
  getSectorAgentGraph: getSectorAgentGraphMock,
}));

vi.mock('./dispatcher', () => ({ dispatcherTick }));

vi.mock('./clearAiOpinionOnFailure', () => ({
  failAiOpinionIfStillProcessing: failAiOpinionIfStillProcessingMock,
}));

import { runAgent, invokeAgent } from './runAgent';
import { InsightRunPublishError } from '@/lib/services/insightService';

const RUN_ID = 'run-1';
const PROMPT = 'Find me Industrial sector companies.';
const STEP_LIMIT_MESSAGE =
  'Run hit the step limit (recursion limit of 50 reached without completing)';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    status: 'running',
    input: { prompt: PROMPT },
    workspace_id: 'ws-1',
    triggered_by_user_id: null,
    agent_name: 'workforce',
    trigger_meta: {},
    ...overrides,
  };
}

function makeAgentResult(opts: {
  finalText?: string;
  messages?: Array<{
    content: unknown;
    tool_calls?: unknown[];
    invalid_tool_calls?: unknown[];
  }>;
} = {}) {
  const messages = opts.messages ?? [
    { content: 'user msg' },
    { content: opts.finalText ?? 'Done.', tool_calls: [] },
  ];
  return { messages };
}

function graph(extra: Record<string, unknown> = {}) {
  return {
    invoke: invokeMock,
    resume: resumeMock,
    getState: vi.fn().mockResolvedValue({}),
    ...extra,
  };
}

function configOf(mock: typeof invokeMock, call = 0) {
  return mock.mock.calls[call]![mock === resumeMock ? 2 : 1] as {
    configurable: Record<string, unknown>;
  };
}

function interruptResult(name: string, args: Record<string, unknown>, description: string) {
  return { messages: [{ content: '' }], interrupt: { actionRequests: [{ name, args, description }] } };
}

const originalKey = process.env.ANTHROPIC_API_KEY;

// By default a run loads a running row, builds a graph, and finishes with 'Done.'.
beforeEach(() => {
  getStepMetadataMock.mockReset().mockReturnValue({ attempt: 1 });
  resolveRecipientMock.mockReset().mockResolvedValue(null);
  notifyTaskWaitingApprovalMock.mockReset().mockResolvedValue(true);
  findById.mockReset();
  heartbeat.mockReset();
  markSucceeded.mockReset();
  markFailed.mockReset().mockResolvedValue({});
  markWaitingForHumanInput.mockReset();
  clearResumeToken.mockReset();
  consumePendingUserMessages.mockReset().mockResolvedValue([]);
  createDb.mockReset().mockReturnValue({});
  invokeMock.mockReset().mockResolvedValue(makeAgentResult());
  resumeMock.mockReset().mockResolvedValue(makeAgentResult({ finalText: 'Resumed.' }));
  getWorkforceAgentGraph.mockReset().mockResolvedValue(graph());
  getSectorAgentGraphMock.mockReset();
  dispatcherTick.mockReset().mockResolvedValue({ outcome: 'empty' });
  failAiOpinionIfStillProcessingMock.mockReset().mockResolvedValue(undefined);
  prepareForMessageMock.mockReset().mockResolvedValue({
    blocks: [{ type: 'file', fileId: 'file-mock' }],
    fileIds: ['file-mock'],
  });
  deleteFromAnthropicMock.mockReset().mockResolvedValue(undefined);
  publishRunDraftMock.mockReset();
  notifyInsightRefreshedMock.mockReset().mockResolvedValue(true);
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

describe('runAgent — happy path', () => {
  it('feeds input.prompt through to the agent with runId as thread_id', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, getState: vi.fn().mockResolvedValue({}) });
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
    // agentRole lets send_email allow presentation attachments.
    expect(configArg).toEqual(
      expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: RUN_ID,
          agentRole: 'workforce',
        }),
      }),
    );
  });

  it('persists final message + counts via markSucceeded', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, getState: vi.fn().mockResolvedValue({}) });
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
    // Spinner clear uses agent_name/trigger_meta from loadAndHeartbeat —
    // no second findById after markSucceeded.
    expect(findById).toHaveBeenCalledTimes(1);
    expect(failAiOpinionIfStillProcessingMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      {},
      'workforce',
    );
  });

  it('passes fund AI Opinion agent_name + trigger_meta through to spinner clear', async () => {
    findById.mockResolvedValueOnce(
      makeRow({
        agent_name: 'fund_ai_opinion',
        trigger_meta: { fund_asset_id: 'asset-1' },
      }),
    );
    getWorkforceAgentGraph.mockResolvedValueOnce({
      invoke: invokeMock,
      getState: vi.fn().mockResolvedValue({}),
    });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    expect(failAiOpinionIfStillProcessingMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      { fund_asset_id: 'asset-1' },
      'fund_ai_opinion',
    );
  });

  it('extracts text from array content-block final content', async () => {
    // @langchain/anthropic returns a tool-using agent's final content as an
    // array of content blocks. The report must be the text, not a
    // JSON.stringify'd block wrapper.
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, getState: vi.fn().mockResolvedValue({}) });
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
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, getState: vi.fn().mockResolvedValue({}) });
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
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, getState: vi.fn().mockResolvedValue({}) });
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
  it('calls markFailed with the error message and re-throws when invoke fails', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, getState: vi.fn().mockResolvedValue({}) });
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

  // The behavioural tests pass with or without the offending import, so this
  // source-level check is what catches the regression: importing
  // @langchain/langgraph drags langsmith's top-level `require("node:fs")` into
  // WDK's VM sandbox and the workflow dies before step 1.
  it('does not import @langchain/* at module scope (WDK sandbox has no require)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('./runAgent.ts', import.meta.url),
      'utf8',
    );
    const langchainImports = src
      .split('\n')
      .filter(
        (line) =>
          /^import\s/.test(line) &&
          /@langchain\//.test(line) &&
          !/^import\s+type\s/.test(line),
      );
    expect(langchainImports).toEqual([]);
  });

  // By the time a recursion error crosses the step RPC boundary it has been
  // rehydrated as a plain Error, so it must be matched by name, not instanceof.
  it.each(['invoke', 'resume'] as const)(
    'treats a rehydrated recursion error on %s as a clean step-limit failure',
    async (path) => {
      findById.mockResolvedValueOnce(
        makeRow(path === 'resume' ? { resume_token: JSON.stringify({ decisions: [] }) } : {}),
      );
      const rehydrated = new Error('Recursion limit of 50 reached without hitting a stop condition.');
      rehydrated.name = 'GraphRecursionError';
      (path === 'resume' ? resumeMock : invokeMock).mockRejectedValueOnce(rehydrated);

      await expect(runAgent({ runId: RUN_ID })).resolves.toBeUndefined();

      expect(markFailed).toHaveBeenCalledTimes(1);
      expect(markFailed).toHaveBeenCalledWith(RUN_ID, {
        code: 'agent_execution_failed',
        message: STEP_LIMIT_MESSAGE,
      });
      expect(markSucceeded).not.toHaveBeenCalled();
      expect(clearResumeToken).toHaveBeenCalledWith(RUN_ID);
      expect(failAiOpinionIfStillProcessingMock).toHaveBeenCalledWith(expect.anything(), 'ws-1', {}, 'workforce');
      expect(dispatcherTick).toHaveBeenCalledTimes(1);
    },
  );
});

describe('runAgent — resume branch (rows carrying a resume_token)', () => {
  it('calls graph.resume with the parsed payload (and not graph.invoke) when resume_token is present', async () => {
    const payload = { decisions: [{ type: 'approve' }] };
    findById.mockResolvedValueOnce(
      makeRow({ resume_token: JSON.stringify(payload) }),
    );
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
    resumeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Resumed.' }));

    await runAgent({ runId: RUN_ID });

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledWith(
      RUN_ID,
      payload,
      expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: RUN_ID,
          agentRole: 'workforce',
        }),
        recursionLimit: 50,
      }),
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });

  // A replayed thread may hold file blocks whose Anthropic uploads were deleted
  // and orphaned tool calls, so it is repaired first; a fresh first attempt has
  // no history to fix.
  it.each([
    { when: 'on resume', resume_token: JSON.stringify({ decisions: [] }), attempt: 1, repairs: true },
    { when: 'on attempt 2 of a fresh run', resume_token: null, attempt: 2, repairs: true },
    { when: 'never on attempt 1 of a fresh run', resume_token: null, attempt: 1, repairs: false },
    { when: 'never when getStepMetadata throws (treated as attempt 1)', resume_token: null, attempt: null, repairs: false },
  ])('repairs the thread $when', async ({ resume_token, attempt, repairs }) => {
    if (attempt === null) {
      getStepMetadataMock.mockImplementationOnce(() => {
        throw new Error('not running under WDK');
      });
    } else {
      getStepMetadataMock.mockReturnValueOnce({ attempt });
    }
    const rewriteFileReferences = vi.fn().mockResolvedValue(undefined);
    const repairOrphanedToolCalls = vi.fn().mockResolvedValue(0);
    findById.mockResolvedValueOnce(makeRow({ resume_token }));
    getWorkforceAgentGraph.mockResolvedValueOnce(graph({ rewriteFileReferences, repairOrphanedToolCalls }));

    await runAgent({ runId: RUN_ID });

    if (repairs) {
      expect(rewriteFileReferences).toHaveBeenCalledWith(RUN_ID, []);
      expect(repairOrphanedToolCalls).toHaveBeenCalledWith(RUN_ID);
    } else {
      expect(rewriteFileReferences).not.toHaveBeenCalled();
      expect(repairOrphanedToolCalls).not.toHaveBeenCalled();
    }
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });

  it('uses graph.invoke (not resume) when resume_token is null', async () => {
    findById.mockResolvedValueOnce(makeRow({ resume_token: null }));
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('clears resume_token before persisting the terminal status', async () => {
    findById.mockResolvedValueOnce(
      makeRow({ resume_token: '{"decisions":[{"type":"approve"}]}' }),
    );
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
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
  it('transitions to waiting_for_human_input when the agent returns an interrupt', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
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
      {
        tool_name: 'promote_l0_to_l1',
        tool_args: {},
        asked_user_id: null,
        asked_at: expect.any(String),
      },
    );
    expect(markSucceeded).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('records the triggering user as the person asked on a non-refresh run and emails them', async () => {
    findById.mockResolvedValueOnce(makeRow({ triggered_by_user_id: 'requester' }));
    resolveRecipientMock.mockResolvedValueOnce('requester');
    invokeMock.mockResolvedValueOnce(
      interruptResult('promote_to_l1', { company_name: 'Acme' }, 'Promote Acme from L0 to L1?'),
    );

    await runAgent({ runId: RUN_ID });

    expect(resolveRecipientMock).toHaveBeenCalledWith(
      { workspace_id: 'ws-1', triggered_by_user_id: 'requester', origin_routine_id: null },
      null,
    );
    expect(markWaitingForHumanInput.mock.calls[0][2]).toMatchObject({ asked_user_id: 'requester' });
    expect(notifyTaskWaitingApprovalMock).toHaveBeenCalledWith(RUN_ID, {
      action: 'Promote Acme from L0 to L1?',
      toolName: 'promote_to_l1',
      toolArgs: { company_name: 'Acme' },
      recipientUserId: 'requester',
    });
  });
});

describe('runAgent — refresh run asks the insight owner and waits (MB-561)', () => {
  const INSIGHT_ID = '22222222-2222-4222-8222-222222222222';
  const ASK_ARGS = {
    question: 'The Q3 report is gone. Use Q2?',
    recommendation: 'Use Q2 and flag the gap',
    rationale: 'Q2 is the latest audited set',
  };
  const refreshRow = (overrides: Record<string, unknown> = {}) =>
    makeRow({ origin_routine_id: 'rt-1', trigger_meta: { insight_id: INSIGHT_ID }, ...overrides });

  beforeEach(() => {
    publishRunDraftMock.mockResolvedValue({
      status: 'published',
      insightId: INSIGHT_ID,
      insightName: 'Weekly pulse',
      versionNo: 4,
      ownerUserId: 'owner-1',
    });
  });

  it('an interrupted refresh run waits on the insight owner and publishes nothing', async () => {
    findById.mockResolvedValueOnce(refreshRow());
    resolveRecipientMock.mockResolvedValueOnce('owner-1');
    invokeMock.mockResolvedValueOnce(interruptResult('ask_owner', ASK_ARGS, ASK_ARGS.question));

    await runAgent({ runId: RUN_ID });

    expect(resolveRecipientMock).toHaveBeenCalledWith(
      { workspace_id: 'ws-1', triggered_by_user_id: null, origin_routine_id: 'rt-1' },
      INSIGHT_ID,
    );
    expect(markWaitingForHumanInput).toHaveBeenCalledWith(RUN_ID, ASK_ARGS.question, {
      tool_name: 'ask_owner',
      tool_args: ASK_ARGS,
      asked_user_id: 'owner-1',
      asked_at: expect.any(String),
    });
    expect(notifyTaskWaitingApprovalMock).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ toolName: 'ask_owner', recipientUserId: 'owner-1' }),
    );
    expect(publishRunDraftMock).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
    expect(notifyInsightRefreshedMock).not.toHaveBeenCalled();
  });

  it('the resumed refresh run completes and publishes exactly once', async () => {
    const decision = {
      decisions: [
        {
          type: 'edit',
          editedAction: {
            name: 'ask_owner',
            args: { ...ASK_ARGS, owner_decision: 'accepted', owner_answer: ASK_ARGS.recommendation },
          },
        },
      ],
    };
    findById.mockResolvedValueOnce(refreshRow({ resume_token: JSON.stringify(decision) }));

    await runAgent({ runId: RUN_ID });

    expect(resumeMock).toHaveBeenCalledWith(RUN_ID, decision, expect.anything());
    expect(invokeMock).not.toHaveBeenCalled();
    expect(publishRunDraftMock).toHaveBeenCalledTimes(1);
    expect(publishRunDraftMock).toHaveBeenCalledWith('ws-1', RUN_ID, INSIGHT_ID, null);
    expect(markSucceeded).toHaveBeenCalledTimes(1);
    expect(markWaitingForHumanInput).not.toHaveBeenCalled();
    expect(notifyInsightRefreshedMock).toHaveBeenCalledTimes(1);
  });
});

describe('runAgent — reactive dispatcher kick', () => {
  it('kicks the dispatcher after markSucceeded on the happy path', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    expect(dispatcherTick).toHaveBeenCalledTimes(1);
    const succeededOrder = markSucceeded.mock.invocationCallOrder[0];
    const dispatchOrder = dispatcherTick.mock.invocationCallOrder[0];
    expect(succeededOrder).toBeLessThan(dispatchOrder);
  });

  it('kicks the dispatcher after markWaitingForHumanInput when the agent pauses', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
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
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
    invokeMock.mockRejectedValueOnce(new Error('LLM unreachable'));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow('LLM unreachable');

    expect(dispatcherTick).toHaveBeenCalledTimes(1);
  });

  it('does not let a dispatcher kick failure bubble out of runAgent', async () => {
    findById.mockResolvedValueOnce(makeRow());
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
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
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, getState: vi.fn().mockResolvedValue({}) });
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
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, getState: vi.fn().mockResolvedValue({}) });
    invokeMock.mockResolvedValueOnce(makeAgentResult({ finalText: 'Done.' }));

    await runAgent({ runId: RUN_ID });

    const [, configArg] = invokeMock.mock.calls[0];
    expect(configArg).toEqual(
      expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: 'original-run-99',
          agentRole: 'workforce',
        }),
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
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
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
      expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: RUN_ID,
          agentRole: 'workforce',
        }),
      }),
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
    getWorkforceAgentGraph.mockResolvedValueOnce({ invoke: invokeMock, resume: resumeMock, getState: vi.fn().mockResolvedValue({}) });
    resumeMock.mockResolvedValueOnce(
      makeAgentResult({ finalText: 'Resumed.' }),
    );

    await runAgent({ runId: RUN_ID });

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('runAgent — attachments, effort tiers, and user attribution', () => {
  const attachments = [
    { key: 'chat-attachments/ws-1/file.pdf', fileName: 'file.pdf', contentType: 'application/pdf' },
  ];

  it('builds a HumanMessage with file blocks when refs are present and cleans up uploads after invoke', async () => {
    findById.mockResolvedValueOnce(makeRow({ input: { prompt: PROMPT, attachments } }));

    await runAgent({ runId: RUN_ID });

    // The Workforce reads a large HTML attachment whole; only chat outlines it.
    expect(prepareForMessageMock).toHaveBeenCalledWith(attachments, { largeHtml: 'full' });
    const [inputArg] = invokeMock.mock.calls[0];
    expect((inputArg as { messages: Array<{ content: unknown }> }).messages[0].content).toEqual([
      { type: 'text', text: PROMPT },
      { type: 'file', fileId: 'file-mock' },
    ]);
    expect(deleteFromAnthropicMock).toHaveBeenCalledWith(['file-mock']);
  });

  it("puts the run's files on the tool config so send_email can send one as-is", async () => {
    findById.mockResolvedValueOnce(makeRow({ input: { prompt: PROMPT, attachments } }));

    await runAgent({ runId: RUN_ID });

    expect(configOf(invokeMock).configurable.attachments).toEqual(attachments);
  });

  it('leaves attachments off the tool config when the run carries none', async () => {
    findById.mockResolvedValueOnce(makeRow({ input: { prompt: PROMPT } }));

    await runAgent({ runId: RUN_ID });

    expect(configOf(invokeMock).configurable).not.toHaveProperty('attachments');
  });

  it('prepares attachments inside the invokeAgent step, not during loadAndHeartbeat', async () => {
    findById.mockResolvedValueOnce(makeRow({ input: { prompt: PROMPT, attachments } }));
    // A null graph fails invokeAgent before it reaches prepareForMessage.
    getWorkforceAgentGraph.mockResolvedValueOnce(null);

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow('workforce agent graph unavailable');

    expect(prepareForMessageMock).not.toHaveBeenCalled();
  });

  it('cleans up Anthropic uploads even when agent invocation fails', async () => {
    findById.mockResolvedValueOnce(makeRow({ input: { prompt: PROMPT, attachments } }));
    invokeMock.mockRejectedValueOnce(new Error('LLM call failed'));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow('LLM call failed');

    expect(deleteFromAnthropicMock).toHaveBeenCalledWith(['file-mock']);
  });

  it.each([
    ['deep', 'deep'],
    ['high', 'high'],
    ['low', 'medium'],
  ])('builds the graph for effort %s at tier %s (low is floored to medium)', async (effort, tier) => {
    findById.mockResolvedValueOnce(makeRow({ input: { prompt: PROMPT, effort } }));

    await runAgent({ runId: RUN_ID });

    expect(getWorkforceAgentGraph).toHaveBeenLastCalledWith(tier);
  });

  it('threads triggered_by_user_id into toolConfig', async () => {
    findById.mockResolvedValueOnce(makeRow({ triggered_by_user_id: 'user-789' }));

    await runAgent({ runId: RUN_ID });

    expect(configOf(invokeMock).configurable.triggered_by_user_id).toBe('user-789');
  });
});

describe('invokeAgent', () => {
  const callInvokeAgent = () =>
    invokeAgent(RUN_ID, PROMPT, null, RUN_ID, [], 'ws-1', 'medium', null);
  const NO_OUTPUT_REASON =
    'The run ended without producing any output — the agent stopped before ' +
    'writing a final message. Nothing was saved — retry the task.';

  it('has maxRetries set to 5', () => {
    expect(invokeAgent.maxRetries).toBe(5);
  });

  it('fails with unparseable tool call reason and <unnamed> when final message is empty and invalid_tool_calls is non-empty', async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [
        { content: 'user msg' },
        { content: '', invalid_tool_calls: [{ name: '', error: 'unexpected end of JSON input' }] },
      ],
    });

    const result = await callInvokeAgent();

    expect(result.kind).toBe('failed');
    const reason = result.kind === 'failed' ? result.reason : '';
    expect(reason).toContain('The run ended on a tool call that could not be parsed');
    expect(reason).toContain('<unnamed>');
    expect(reason).toContain('unexpected end of JSON input');
  });

  it('fails with the provider error when the agent swallowed an invocation error into its final message', async () => {
    const swallowed =
      'Error invoking agent: 400 {"type":"error","error":{"message":"Your credit balance is too low"}}';
    invokeMock.mockResolvedValueOnce({
      messages: [{ content: 'user msg' }, { content: swallowed }],
    });

    expect(await callInvokeAgent()).toEqual({ kind: 'failed', reason: swallowed });
  });

  it.each([
    ['empty with no invalid_tool_calls', { content: '' }],
    ['whitespace with an empty invalid_tool_calls', { content: '   ', invalid_tool_calls: [] }],
  ])('fails with the generic no-output reason when the final message is %s', async (_label, last) => {
    invokeMock.mockResolvedValueOnce({ messages: [{ content: 'user msg' }, last] });

    expect(await callInvokeAgent()).toEqual({ kind: 'failed', reason: NO_OUTPUT_REASON });
  });
});

describe('runAgent — pre-step crash handling', () => {
  it('marks row failed with agent_load_failed code and re-throws when loadAndHeartbeat throws and row is still running', async () => {
    findById.mockResolvedValue(makeRow({ status: 'running' }));
    heartbeat.mockRejectedValueOnce(new Error('Database connectivity error'));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow('Database connectivity error');

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(RUN_ID, {
      code: 'agent_load_failed',
      message: 'Database connectivity error',
    });
    expect(dispatcherTick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['succeeded', makeRow({ status: 'succeeded' }), /is in status succeeded, expected 'running'/],
    ['failed', makeRow({ status: 'failed' }), /is in status failed, expected 'running'/],
    ['missing', null, /row run-1 not found/],
  ] as const)(
    'leaves row alone and re-throws when loadAndHeartbeat throws and row is %s',
    async (_label, row, error) => {
      findById.mockResolvedValue(row);

      await expect(runAgent({ runId: RUN_ID })).rejects.toThrow(error);

      expect(markFailed).not.toHaveBeenCalled();
      expect(dispatcherTick).not.toHaveBeenCalled();
    },
  );
});

describe('runAgent — insight refresh runs (MB-558)', () => {
  const INSIGHT_ID = '11111111-1111-4111-8111-111111111111';
  const refreshRow = (overrides: Record<string, unknown> = {}) =>
    makeRow({ origin_routine_id: 'rt-1', trigger_meta: { insight_id: INSIGHT_ID }, ...overrides });

  beforeEach(() => {
    publishRunDraftMock.mockResolvedValue({ status: 'already_published', insightId: INSIGHT_ID, versionNo: 1 });
  });

  it('refresh run (origin_routine_id + trigger_meta.insight_id) → publishRunDraft called with (workspaceId, runId, insightId) and before markSucceeded', async () => {
    findById.mockResolvedValueOnce(refreshRow());

    await runAgent({ runId: RUN_ID });

    expect(publishRunDraftMock).toHaveBeenCalledTimes(1);
    expect(publishRunDraftMock).toHaveBeenCalledWith('ws-1', RUN_ID, INSIGHT_ID, null);
    expect(publishRunDraftMock.mock.invocationCallOrder[0]).toBeLessThan(
      markSucceeded.mock.invocationCallOrder[0],
    );
    expect(configOf(invokeMock).configurable).toMatchObject({
      run_id: RUN_ID,
      origin_routine_id: 'rt-1',
      refresh_insight_id: INSIGHT_ID,
    });
  });

  it('refresh via input.insight_id fallback (retry) is detected', async () => {
    findById.mockResolvedValueOnce(
      refreshRow({ trigger_meta: {}, input: { prompt: PROMPT, insight_id: INSIGHT_ID } }),
    );

    await runAgent({ runId: RUN_ID });

    expect(publishRunDraftMock).toHaveBeenCalledWith('ws-1', RUN_ID, INSIGHT_ID, null);
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no origin_routine_id', makeRow({ origin_routine_id: null })],
    ['an origin without an insight id', refreshRow({ trigger_meta: {} })],
  ])('a non-refresh run (%s) publishes nothing and carries null refresh ids', async (_label, row) => {
    findById.mockResolvedValueOnce(row);

    await runAgent({ runId: RUN_ID });

    expect(publishRunDraftMock).not.toHaveBeenCalled();
    expect(configOf(invokeMock).configurable).toMatchObject({ run_id: RUN_ID, refresh_insight_id: null });
  });

  it('InsightRunPublishError → markSucceeded NOT called and markFailed called with code refresh_publish_refused + the message', async () => {
    findById.mockResolvedValueOnce(refreshRow());
    publishRunDraftMock.mockRejectedValueOnce(
      new InsightRunPublishError(
        'structural_check_failed',
        'refresh draft failed the structural check: empty body',
      ),
    );

    await runAgent({ runId: RUN_ID });

    expect(markSucceeded).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(RUN_ID, {
      code: 'refresh_publish_refused',
      message: 'refresh draft failed the structural check: empty body',
    });
  });

  it.each(['already_published', 'unchanged'])(
    '%s → markSucceeded called, notifyInsightRefreshed NOT called',
    async (status) => {
      findById.mockResolvedValueOnce(refreshRow());
      publishRunDraftMock.mockResolvedValueOnce({ status, insightId: INSIGHT_ID, versionNo: 3 });

      await runAgent({ runId: RUN_ID });

      expect(markSucceeded).toHaveBeenCalledTimes(1);
      expect(markFailed).not.toHaveBeenCalled();
      expect(notifyInsightRefreshedMock).not.toHaveBeenCalled();
    },
  );

  it('published → notifyInsightRefreshed called with the owner', async () => {
    findById.mockResolvedValueOnce(refreshRow());
    publishRunDraftMock.mockResolvedValueOnce({
      status: 'published',
      insightId: INSIGHT_ID,
      insightName: 'Market Trends Q3',
      versionNo: 5,
      baseMoved: false,
      ownerUserId: 'user-owner-1',
    });

    await runAgent({ runId: RUN_ID });

    expect(markSucceeded).toHaveBeenCalledTimes(1);
    expect(notifyInsightRefreshedMock).toHaveBeenCalledTimes(1);
    expect(notifyInsightRefreshedMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      insightId: INSIGHT_ID,
      insightName: 'Market Trends Q3',
      versionNo: 5,
      ownerUserId: 'user-owner-1',
    });
  });

  it('treats a one-off refresh (no routine, input.insight_refresh) as a refresh and publishes it (MB-552)', async () => {
    findById.mockResolvedValueOnce(
      makeRow({
        origin_routine_id: null,
        trigger_meta: { insight_id: INSIGHT_ID, manual: true },
        input: { prompt: 'Refresh it', insight_id: INSIGHT_ID, insight_refresh: true, agent_key: 'general' },
      }),
    );

    await runAgent({ runId: RUN_ID });

    expect(configOf(invokeMock).configurable).toMatchObject({
      origin_routine_id: null,
      refresh_insight_id: INSIGHT_ID,
    });
    expect(publishRunDraftMock).toHaveBeenCalledWith('ws-1', RUN_ID, INSIGHT_ID, null);
  });

  it('a non-InsightRunPublishError from publish rethrows / does not markSucceeded', async () => {
    findById.mockResolvedValueOnce(refreshRow());
    publishRunDraftMock.mockRejectedValueOnce(new Error('database connection timeout'));

    await expect(runAgent({ runId: RUN_ID })).rejects.toThrow('database connection timeout');

    expect(markSucceeded).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(RUN_ID, {
      code: 'agent_execution_failed',
      message: 'database connection timeout',
    });
  });
});

describe('runAgent — refresh runs on the bound agent (MB-560)', () => {
  const INSIGHT_ID = '22222222-2222-4222-8222-222222222222';

  function refreshRow(input: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return makeRow({
      origin_routine_id: 'rt-1',
      trigger_meta: { insight_id: INSIGHT_ID },
      input: { prompt: PROMPT, insight_id: INSIGHT_ID, ...input },
      ...overrides,
    });
  }

  beforeEach(() => {
    getSectorAgentGraphMock.mockResolvedValue(graph());
    publishRunDraftMock.mockResolvedValue({ status: 'unchanged', insightId: INSIGHT_ID, versionNo: 4 });
  });

  it('builds the sector workforce graph for a refresh run whose row names a sector agent, at the run effort', async () => {
    findById.mockResolvedValueOnce(refreshRow({ agent_key: 'minerba', effort: 'high' }));

    await runAgent({ runId: RUN_ID });

    expect(getSectorAgentGraphMock).toHaveBeenCalledWith('minerba', 'workforce', 'high');
    expect(getWorkforceAgentGraph).not.toHaveBeenCalled();
    expect(configOf(invokeMock).configurable.agent_key).toBe('minerba');
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });

  it('builds the general workforce graph for general, a missing key (pre-MB-560 rows) and an unknown key', async () => {
    for (const input of [{ agent_key: 'general' }, {}, { agent_key: 'retired' }]) {
      invokeMock.mockClear();
      findById.mockResolvedValueOnce(refreshRow(input));

      await runAgent({ runId: RUN_ID });

      expect(configOf(invokeMock).configurable).not.toHaveProperty('agent_key');
    }
    expect(getSectorAgentGraphMock).not.toHaveBeenCalled();
    expect(getWorkforceAgentGraph).toHaveBeenCalledTimes(3);
  });

  it('ignores an agent_key on a non-refresh run — only refresh runs pick their agent', async () => {
    findById.mockResolvedValueOnce(
      makeRow({ origin_routine_id: null, input: { prompt: PROMPT, agent_key: 'bangun' } }),
    );

    await runAgent({ runId: RUN_ID });

    expect(getSectorAgentGraphMock).not.toHaveBeenCalled();
    expect(getWorkforceAgentGraph).toHaveBeenCalledTimes(1);
  });

  it('a HITL resume rebuilds the sector graph the run started on', async () => {
    const payload = { decisions: [{ type: 'edit' }] };
    findById.mockResolvedValueOnce(
      refreshRow({ agent_key: 'dikti' }, { resume_token: JSON.stringify(payload) }),
    );

    await runAgent({ runId: RUN_ID });

    expect(getSectorAgentGraphMock).toHaveBeenCalledWith('dikti', 'workforce', expect.any(String));
    expect(resumeMock).toHaveBeenCalledWith(RUN_ID, payload, expect.anything());
    expect(configOf(resumeMock).configurable.agent_key).toBe('dikti');
  });

  // The stamp comes from the run row alone — finalize never re-reads the
  // insight's (possibly since-rebound) binding.
  it.each(['bangun', 'minerba'])("stamps the published version with the run row's agent %s", async (agentKey) => {
    findById.mockResolvedValueOnce(refreshRow({ agent_key: agentKey }));

    await runAgent({ runId: RUN_ID });

    expect(findById).toHaveBeenCalledTimes(1);
    expect(publishRunDraftMock).toHaveBeenCalledWith('ws-1', RUN_ID, INSIGHT_ID, { agentKey });
  });

  it('an unavailable sector graph is retryable, naming the agent', async () => {
    getSectorAgentGraphMock.mockResolvedValueOnce(null);

    await expect(
      invokeAgent(RUN_ID, PROMPT, null, RUN_ID, [], 'ws-1', 'medium', null, null, undefined, {
        originRoutineId: 'rt-1',
        refreshInsightId: INSIGHT_ID,
        agentKey: 'bangun',
      }),
    ).rejects.toThrow('sector agent graph unavailable (bangun)');
  });
});
