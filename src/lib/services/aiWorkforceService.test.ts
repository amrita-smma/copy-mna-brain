import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueAgentRun, captureMock } = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(),
  captureMock: vi.fn(),
}));

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));

vi.mock('@/lib/posthog-server', () => ({
  captureWorkspaceEvent: captureMock,
}));

import {
  AiWorkforceService,
  TaskBusyError,
  TaskNotFoundError,
  TaskOwnershipError,
  describeRunFailure,
} from './aiWorkforceService';

function makeService(findById: ReturnType<typeof vi.fn>) {
  const queueRepo = { findById } as never;
  const db = {} as never;
  return new AiWorkforceService(queueRepo, db);
}

function makeServiceWith(
  queueRepo: Record<string, ReturnType<typeof vi.fn>>,
) {
  return new AiWorkforceService(queueRepo as never, {} as never);
}

describe('AiWorkforceService.getGlobalQueuePositions', () => {
  it('delegates to the repository unchanged', async () => {
    const positions = new Map([['r1', 2]]);
    const getGlobalQueuePositions = vi.fn().mockResolvedValue(positions);
    const service = makeServiceWith({ getGlobalQueuePositions });

    const result = await service.getGlobalQueuePositions(['r1']);

    expect(getGlobalQueuePositions).toHaveBeenCalledWith(['r1']);
    expect(result).toBe(positions);
  });
});

describe('AiWorkforceService.enqueueFromChat', () => {
  beforeEach(() => {
    enqueueAgentRun.mockReset();
    captureMock.mockReset();
  });

  it('captures a workforce_task_assigned PostHog event attributed to the user', async () => {
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });
    const service = makeService(
      vi.fn().mockResolvedValueOnce({
        id: 'run-1',
        status: 'pending',
        workspace_id: 'ws-1',
      }),
    );

    await service.enqueueFromChat({
      agent_name: 'chat_handoff',
      title: 't',
      instruction: 'i',
      conversation_id: 'conv-7',
      user_id: 'user-1',
      priority: 3,
    });

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        distinctId: 'user-1',
        event: 'workforce_task_assigned',
        properties: expect.objectContaining({
          run_id: 'run-1',
          agent_name: 'chat_handoff',
          priority: 3,
          has_conversation: true,
        }),
      }),
    );
  });

  it('routes through enqueueAgentRun with the right shape + idempotency key + user id', async () => {
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });
    const findById = vi.fn().mockResolvedValueOnce({
      id: 'run-1',
      status: 'pending',
      created_at: '2026-05-11T00:00:00Z',
    });
    const service = makeService(findById);

    const row = await service.enqueueFromChat({
      agent_name: 'chat_handoff',
      title: 'Outbound + L0/L1 + write',
      instruction: 'Search and add Korean CMP suppliers at L0.',
      conversation_id: 'conv-7',
      tool_call_id: 'toolu_42',
      user_id: 'user-1',
    });

    expect(row.id).toBe('run-1');
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentName: 'chat_handoff',
        triggerSource: 'chat',
        triggerMeta: {
          conversation_id: 'conv-7',
          tool_call_id: 'toolu_42',
          user_id: 'user-1',
        },
        triggeredByUserId: 'user-1',
        idempotencyKey: 'toolu_42',
      }),
    );
  });

  it('mirrors instruction into input.prompt so runAgent and Haiku title-gen read it', async () => {
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'r2', created: true });
    const service = makeService(vi.fn().mockResolvedValueOnce({ id: 'r2' }));

    await service.enqueueFromChat({
      agent_name: 'chat_handoff',
      title: 't',
      instruction: 'do the thing',
    });

    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: {
          title: 't',
          instruction: 'do the thing',
          prompt: 'do the thing',
          effort: 'medium',
        },
      }),
    );
  });

  it('passes through priority and nulls unset trigger_meta fields', async () => {
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'r3', created: true });
    const service = makeService(vi.fn().mockResolvedValueOnce({ id: 'r3' }));

    await service.enqueueFromChat({
      agent_name: 'outbound_pipeline_writer',
      title: 't',
      instruction: 'i',
      priority: 5,
    });

    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        priority: 5,
        triggerMeta: {
          conversation_id: null,
          tool_call_id: null,
          user_id: null,
        },
        triggeredByUserId: null,
        idempotencyKey: null,
      }),
    );
  });

  it('throws when the row cannot be fetched after enqueue', async () => {
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'gone', created: true });
    const service = makeService(vi.fn().mockResolvedValueOnce(null));

    await expect(
      service.enqueueFromChat({
        agent_name: 'x',
        title: 't',
        instruction: 'i',
      }),
    ).rejects.toThrow(/row gone was inserted but findById returned null/);
  });

  it('carries attachments through into input jsonb when present', async () => {
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'r-att', created: true });
    const service = makeService(vi.fn().mockResolvedValueOnce({ id: 'r-att' }));

    const attachments = [{ key: 'chat-attachments/ws-1/a.xlsx', fileName: 'a.xlsx', contentType: 'application/xlsx' }];

    await service.enqueueFromChat({
      agent_name: 'chat_handoff',
      title: 'Analyze sheet',
      instruction: 'Run analysis',
      attachments,
    });

    expect(enqueueAgentRun.mock.calls[0][1].input.attachments).toEqual(attachments);
  });
});

describe('AiWorkforceService.submitUserMessage', () => {
  beforeEach(() => {
    enqueueAgentRun.mockReset();
  });

  it('throws TaskNotFoundError when the row is missing', async () => {
    const service = makeServiceWith({
      findById: vi.fn().mockResolvedValueOnce(null),
      appendPendingUserMessage: vi.fn().mockResolvedValue({ row: { status: 'pending' }, queue_position: 1 }),
    });
    await expect(
      service.submitUserMessage({
        runId: 'missing',
        userId: 'u1',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('throws TaskOwnershipError when caller is not triggered_by_user_id', async () => {
    const service = makeServiceWith({
      findById: vi.fn().mockResolvedValueOnce({
        id: 'r1',
        triggered_by_user_id: 'someone-else',
        status: 'pending',
      }),
      appendPendingUserMessage: vi.fn().mockResolvedValue({ row: { status: 'pending' }, queue_position: 1 }),
    });
    await expect(
      service.submitUserMessage({
        runId: 'r1',
        userId: 'u1',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(TaskOwnershipError);
  });

  it('throws TaskBusyError when status is running', async () => {
    const service = makeServiceWith({
      findById: vi.fn().mockResolvedValueOnce({
        id: 'r1',
        triggered_by_user_id: 'u1',
        status: 'running',
      }),
      appendPendingUserMessage: vi.fn().mockResolvedValue({ row: { status: 'pending' }, queue_position: 1 }),
    });
    await expect(
      service.submitUserMessage({ runId: 'r1', userId: 'u1', text: 'hi' }),
    ).rejects.toBeInstanceOf(TaskBusyError);
  });

  it('throws TaskBusyError when status is waiting_for_subagent', async () => {
    const service = makeServiceWith({
      findById: vi.fn().mockResolvedValueOnce({
        id: 'r1',
        triggered_by_user_id: 'u1',
        status: 'waiting_for_subagent',
      }),
      appendPendingUserMessage: vi.fn().mockResolvedValue({ row: { status: 'pending' }, queue_position: 1 }),
    });
    await expect(
      service.submitUserMessage({ runId: 'r1', userId: 'u1', text: 'hi' }),
    ).rejects.toBeInstanceOf(TaskBusyError);
  });

  it('throws when text is empty after trim', async () => {
    const service = makeServiceWith({
      findById: vi.fn(),
      appendPendingUserMessage: vi.fn().mockResolvedValue({ row: { status: 'pending' }, queue_position: 1 }),
    });
    await expect(
      service.submitUserMessage({
        runId: 'r1',
        userId: 'u1',
        text: '   \n  ',
      }),
    ).rejects.toThrow(/text is required/);
  });

  for (const status of [
    'pending',
    'waiting_for_human_input',
    'resume_ready',
  ] as const) {
    it(`attaches and returns queue_position when status is ${status}`, async () => {
      const appendPendingUserMessage = vi.fn().mockResolvedValueOnce({
        row: { id: 'r1', status },
        queue_position: 3,
      });
      const service = makeServiceWith({
        findById: vi.fn().mockResolvedValueOnce({
          id: 'r1',
          triggered_by_user_id: 'u1',
          status,
        }),
        appendPendingUserMessage,
      });
      const result = await service.submitUserMessage({
        runId: 'r1',
        userId: 'u1',
        text: '  do the thing  ',
      });
      expect(result).toEqual({
        kind: 'attached',
        message_id: expect.any(String),
        queue_position: 3,
        status,
      });
      expect(enqueueAgentRun).not.toHaveBeenCalled();
      const [calledRunId, calledMsg] = appendPendingUserMessage.mock.calls[0];
      expect(calledRunId).toBe('r1');
      expect(calledMsg).toEqual({
        id: expect.any(String),
        text: 'do the thing',
        submitted_at: expect.any(String),
        submitted_by_user_id: 'u1',
      });
    });
  }

  it.each(['succeeded', 'failed', 'rejected', 'timed_out'] as const)(
    'attaches message and sets status to pending when status is %s (terminal)',
    async (status) => {
      const appendPendingUserMessage = vi.fn().mockResolvedValueOnce({
        row: { status: 'pending' },
        queue_position: 1,
      });
      const service = makeServiceWith({
        findById: vi.fn().mockResolvedValueOnce({
          id: 'orig',
          triggered_by_user_id: 'u1',
          status,
          agent_name: 'analysis',
          input: { title: 'Original task' },
          title: 'Original task',
          priority: 7,
        }),
        appendPendingUserMessage,
      });

      const result = await service.submitUserMessage({
        runId: 'orig',
        userId: 'u1',
        text: 'follow up on Acme',
      });

      expect(result).toEqual({
        kind: 'attached',
        message_id: expect.any(String),
        queue_position: 1,
        status: 'pending',
      });
      expect(appendPendingUserMessage).toHaveBeenCalledWith(
        'orig',
        expect.objectContaining({
          text: 'follow up on Acme',
          submitted_by_user_id: 'u1',
        }),
        'pending'
      );
      expect(enqueueAgentRun).not.toHaveBeenCalled();
    },
  );

  it('reopened task keeps parent row effort when forking a new run', async () => {
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'forked-1', created: true });
    const service = makeServiceWith({
      findById: vi.fn().mockResolvedValueOnce({
        id: 'orig',
        triggered_by_user_id: 'u1',
        status: 'archived' as any,
        agent_name: 'analysis',
        input: { title: 'Original task', effort: 'deep' },
        title: 'Original task',
        priority: 7,
      }),
    });

    const result = await service.submitUserMessage({
      runId: 'orig',
      userId: 'u1',
      text: 'follow up on deep task',
    });

    expect(result).toMatchObject({ kind: 'forked', new_run_id: 'forked-1' });
    expect(enqueueAgentRun.mock.calls[0][1].input).toMatchObject({ effort: 'deep', follow_up_thread_id: 'orig' });
  });
});

describe('AiWorkforceService.getMessageTimestamps', () => {
  it('returns undefined and does not reject when checkpointRepo throws', async () => {
    const checkpointRepo = {
      listMessageWrites: vi.fn().mockRejectedValue(new Error('db connection lost')),
    };
    const service = new AiWorkforceService({} as never, {} as never, checkpointRepo as never);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await service.getMessageTimestamps('thread-1', []);

    expect(result).toBeUndefined();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[workforce] trace timestamps unavailable',
      expect.any(Error),
    );
    consoleWarn.mockRestore();
  });

  it('delegates to checkpointRepo and matchMessageTimestamps on success', async () => {
    const checkpointRepo = {
      listMessageWrites: vi.fn().mockResolvedValue([
        { ts: '2026-05-15T10:01:00Z', kind: 'ai', id: 'ai-1', toolCallId: null },
      ]),
    };
    const service = new AiWorkforceService({} as never, {} as never, checkpointRepo as never);
    const { AIMessage } = await import('@langchain/core/messages');
    const msg = new AIMessage({ content: 'test', id: 'ai-1' });

    const result = await service.getMessageTimestamps('thread-1', [msg]);

    expect(checkpointRepo.listMessageWrites).toHaveBeenCalledWith('thread-1');
    expect(result).toEqual(['2026-05-15T10:01:00Z']);
  });
});

describe('describeRunFailure', () => {
  it.each([
    ['failed', { code: 'refresh_publish_refused', message: 'draft truncated' }, 'draft truncated'],
    ['failed', { code: 'cancelled_by_user' }, 'Cancelled by user'],
    ['failed', { code: 'cancelled_by_user', reason: 'wrong prompt' }, 'Cancelled by user: wrong prompt'],
    ['failed', { code: 'stuck_no_heartbeat' }, 'stuck_no_heartbeat'],
    ['timed_out', null, 'Timed out'],
    ['rejected', null, 'Rejected'],
    ['failed', null, 'Failed without a recorded reason'],
    // Never renders the notifications array.
    ['failed', { notifications: [{ id: 'n1' }] }, 'Failed without a recorded reason'],
  ] as const)('describes a %s run with error %j as %j', (status, error, expected) => {
    expect(describeRunFailure(status, error as never)).toBe(expected);
  });
});

describe('AiWorkforceService.listFailedRefreshRuns', () => {
  it('maps each run to its id, status, reason and timestamps in one repository call', async () => {
    const findUnsuccessfulRefreshRunsByInsightId = vi.fn().mockResolvedValue([
      {
        id: 'run-2',
        status: 'failed',
        error: { code: 'refresh_publish_refused', message: 'insight archived' },
        created_at: '2026-09-24T01:00:00Z',
        ended_at: '2026-09-24T01:05:00Z',
      },
      { id: 'run-1', status: 'timed_out', error: null, created_at: '2026-09-23T01:00:00Z', ended_at: null },
    ]);
    const service = makeServiceWith({ findUnsuccessfulRefreshRunsByInsightId });

    const result = await service.listFailedRefreshRuns('insight-1');

    expect(findUnsuccessfulRefreshRunsByInsightId).toHaveBeenCalledTimes(1);
    expect(findUnsuccessfulRefreshRunsByInsightId).toHaveBeenCalledWith('insight-1');
    expect(result).toEqual([
      {
        run_id: 'run-2',
        status: 'failed',
        reason: 'insight archived',
        created_at: '2026-09-24T01:00:00Z',
        ended_at: '2026-09-24T01:05:00Z',
      },
      { run_id: 'run-1', status: 'timed_out', reason: 'Timed out', created_at: '2026-09-23T01:00:00Z', ended_at: null },
    ]);
  });
});
