import { describe, expect, it, vi } from 'vitest';
import { AgentCheckpointRepository } from './agentCheckpointRepository';

describe('AgentCheckpointRepository.listMessageWrites', () => {
  it('returns [] without querying when threadId is empty', async () => {
    const execute = vi.fn();
    const repo = new AgentCheckpointRepository({ execute } as never);

    expect(await repo.listMessageWrites('')).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps each message class (and its Chunk variant) to a kind, and anything else to other', async () => {
    const classes = [
      'AIMessage',
      'AIMessageChunk',
      'ToolMessage',
      'ToolMessageChunk',
      'HumanMessage',
      'HumanMessageChunk',
      'SystemMessage',
      null,
    ];
    const rows = classes.map((cls, i) => ({
      ts: `t${i}`,
      cls,
      msg_id: i === 0 ? 'msg-1' : undefined,
      tool_call_id: i === 2 ? 'call-1' : null,
    }));
    const execute = vi.fn().mockResolvedValue({ rows });
    const repo = new AgentCheckpointRepository({ execute } as never);

    const result = await repo.listMessageWrites('thread-123');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.map((r) => r.kind)).toEqual(['ai', 'ai', 'tool', 'tool', 'human', 'human', 'other', 'other']);
    expect(result[0]).toEqual({ ts: 't0', kind: 'ai', id: 'msg-1', toolCallId: null });
    expect(result[2]).toEqual({ ts: 't2', kind: 'tool', id: null, toolCallId: 'call-1' });
  });

  it('handles an array returned directly from execute', async () => {
    const execute = vi.fn().mockResolvedValue([{ ts: 't', cls: 'AIMessage', msg_id: 'm', tool_call_id: null }]);
    const repo = new AgentCheckpointRepository({ execute } as never);

    expect(await repo.listMessageWrites('thread-123')).toEqual([{ ts: 't', kind: 'ai', id: 'm', toolCallId: null }]);
  });
});
