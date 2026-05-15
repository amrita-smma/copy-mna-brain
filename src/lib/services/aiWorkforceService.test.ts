import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueAgentRun } = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(),
}));

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));

import { AiWorkforceService } from './aiWorkforceService';

function makeService(findById: ReturnType<typeof vi.fn>) {
  const queueRepo = { findById } as never;
  const db = {} as never;
  return new AiWorkforceService(queueRepo, db);
}

describe('AiWorkforceService.enqueueFromChat', () => {
  beforeEach(() => {
    enqueueAgentRun.mockReset();
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
});
