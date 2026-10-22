import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
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

const dialect = new PgDialect();
const toQuery = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

describe('AgentCheckpointRepository.compactThread', () => {
  function txDb(rowCounts: number[]) {
    const execute = vi.fn();
    for (const n of rowCounts) execute.mockResolvedValueOnce({ rowCount: n });
    const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn({ execute }));
    return { execute, transaction };
  }

  it('in one transaction, deletes older checkpoints, their writes, and blobs nothing still references', async () => {
    const db = txDb([7, 3, 5]);
    const repo = new AgentCheckpointRepository(db as never);

    await expect(repo.compactThread('chat-1', 2)).resolves.toEqual({ writes: 7, checkpoints: 3, blobs: 5 });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const [writes, checkpoints, blobs] = db.execute.mock.calls.map((c) => toQuery(c[0]));
    expect(writes.sql).toContain('DELETE FROM agent_states.checkpoint_writes');
    expect(writes.sql).toContain('ORDER BY checkpoint_id DESC');
    expect(writes.params).toEqual(['chat-1', 'chat-1', 2]);
    expect(checkpoints.sql).toContain('DELETE FROM agent_states.checkpoints');
    expect(checkpoints.sql).toContain('NOT IN');
    expect(blobs.sql).toContain('DELETE FROM agent_states.checkpoint_blobs');
    expect(blobs.sql).toContain("c.checkpoint -> 'channel_versions' ->> b.channel = b.version");
  });

  it('does nothing for no thread or a keep below one', async () => {
    const db = txDb([]);
    const repo = new AgentCheckpointRepository(db as never);

    await expect(repo.compactThread('', 2)).resolves.toEqual({ checkpoints: 0, writes: 0, blobs: 0 });
    await expect(repo.compactThread('chat-1', 0)).resolves.toEqual({ checkpoints: 0, writes: 0, blobs: 0 });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('AgentCheckpointRepository.listCompactableThreads', () => {
  it('only lists idle, unlocked Copilot chat threads over the keep count', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ thread_id: 't1' }, { thread_id: 't2' }] });
    const repo = new AgentCheckpointRepository({ execute } as never);

    await expect(repo.listCompactableThreads({ keep: 2, idleMinutes: 15, limit: 100 })).resolves.toEqual(['t1', 't2']);

    const q = toQuery(execute.mock.calls[0][0]);
    expect(q.sql).toContain('JOIN copilot_chats ch ON ch.id::text = c.thread_id');
    expect(q.sql).toContain('ch.busy_until IS NULL OR ch.busy_until < now()');
    expect(q.sql).toContain('HAVING count(*) >');
    expect(q.params).toEqual([15, 2, 100]);
  });
});
