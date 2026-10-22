import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list, del } = vi.hoisted(() => ({ list: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ userTaskService: { list, delete: del } })) }));

import { deleteTask } from './delete_task';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';

describe('delete_task', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([
      { id: 't1', title: 'Call Budi', remindAt: null, completedAt: null, createdAt: 'c' },
      { id: 't2', title: 'Call Ana', remindAt: null, completedAt: null, createdAt: 'c' },
    ]);
    del.mockReset().mockResolvedValue(true);
  });

  it('deletes the one task the reference names, as the chatting user', async () => {
    expect(await deleteTask.invoke({ task: 'ana' }, BOT_TOOL_CONFIG)).toBe('Deleted the task "Call Ana" (id t2).');
    expect(del).toHaveBeenCalledWith('u1', 't2');
  });

  it('refuses an ambiguous reference and reports a task already gone', async () => {
    expect(await deleteTask.invoke({ task: 'call' }, BOT_TOOL_CONFIG)).toContain('no single task matches "call"');
    expect(del).not.toHaveBeenCalled();
    del.mockResolvedValueOnce(false);
    expect(await deleteTask.invoke({ task: 't1' }, BOT_TOOL_CONFIG)).toContain('already gone');
  });
});
