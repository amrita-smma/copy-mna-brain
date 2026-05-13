import { describe, expect, it, vi } from 'vitest';

import { AiWorkforceService } from './aiWorkforceService';

describe('AiWorkforceService.enqueueFromChat', () => {
  it('writes a chat-triggered row with title and instruction in input', async () => {
    const enqueue = vi.fn().mockResolvedValue({
      id: 'run-1',
      status: 'pending',
      created_at: '2026-05-11T00:00:00Z',
    });
    const service = new AiWorkforceService({ enqueue } as never);

    const row = await service.enqueueFromChat({
      agent_name: 'chat_handoff',
      title: 'Outbound + L0/L1 + write',
      instruction: 'Search and add Korean CMP suppliers at L0.',
      conversation_id: 'conv-7',
      tool_call_id: 'toolu_42',
    });

    expect(row.id).toBe('run-1');
    expect(enqueue).toHaveBeenCalledWith({
      agent_name: 'chat_handoff',
      trigger_source: 'chat',
      trigger_meta: {
        conversation_id: 'conv-7',
        tool_call_id: 'toolu_42',
        user_id: null,
      },
      input: {
        title: 'Outbound + L0/L1 + write',
        instruction: 'Search and add Korean CMP suppliers at L0.',
      },
      priority: 0,
    });
  });

  it('passes through priority and nulls unset trigger_meta fields', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'run-2' });
    const service = new AiWorkforceService({ enqueue } as never);

    await service.enqueueFromChat({
      agent_name: 'outbound_pipeline_writer',
      title: 't',
      instruction: 'i',
      priority: 5,
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 5,
        trigger_meta: {
          conversation_id: null,
          tool_call_id: null,
          user_id: null,
        },
      }),
    );
  });
});
