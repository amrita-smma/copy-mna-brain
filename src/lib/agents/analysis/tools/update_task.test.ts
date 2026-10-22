import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list, update } = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ userTaskService: { list, update } })) }));

import { updateTask } from './update_task';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';
import { UserTaskValidationError } from '@/lib/services/userTaskService';

const tasks = [
  { id: 't1', title: 'Call Budi', remindAt: null, completedAt: null, createdAt: 'c' },
  { id: 't2', title: 'Call Ana', remindAt: null, completedAt: null, createdAt: 'c' },
];

describe('update_task', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue(tasks);
    update.mockReset().mockImplementation(async (_u, id, patch) => ({
      ...tasks.find((t) => t.id === id)!,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.remindAt !== undefined ? { remindAt: patch.remindAt } : {}),
      ...(patch.completed !== undefined ? { completedAt: patch.completed ? '2026-10-21T10:00:00.000Z' : null } : {}),
    }));
  });

  it('marks a task done by its title, and reopens one by id', async () => {
    expect(await updateTask.invoke({ task: 'call budi', completed: true }, BOT_TOOL_CONFIG)).toBe(
      'Marked done: Call Budi — done 2026-10-21T10:00:00.000Z (id t1).',
    );
    expect(update).toHaveBeenCalledWith('u1', 't1', { completed: true });
    expect(await updateTask.invoke({ task: 't2', completed: false }, BOT_TOOL_CONFIG)).toMatch(/^Reopened: Call Ana/);
  });

  it('renames and moves or clears the reminder, sending only the fields given', async () => {
    await updateTask.invoke({ task: 't1', title: 'Call Budi today', remind_at: '2026-10-22T09:00:00+07:00' }, BOT_TOOL_CONFIG);
    expect(update).toHaveBeenLastCalledWith('u1', 't1', { title: 'Call Budi today', remindAt: '2026-10-22T09:00:00+07:00' });
    await updateTask.invoke({ task: 't1', remind_at: null }, BOT_TOOL_CONFIG);
    expect(update).toHaveBeenLastCalledWith('u1', 't1', { remindAt: null });
  });

  it('refuses an ambiguous or unknown task, an empty change, and relays a validation error', async () => {
    expect(await updateTask.invoke({ task: 'call', completed: true }, BOT_TOOL_CONFIG)).toContain('no single task matches "call"');
    expect(await updateTask.invoke({ task: 'nothing', completed: true }, BOT_TOOL_CONFIG)).toContain('no single task matches');
    expect(await updateTask.invoke({ task: 't1' }, BOT_TOOL_CONFIG)).toContain('Rejection: pass a new title');
    expect(update).not.toHaveBeenCalled();
    update.mockRejectedValueOnce(new UserTaskValidationError('title is required'));
    expect(await updateTask.invoke({ task: 't1', title: ' ' }, BOT_TOOL_CONFIG)).toBe('Rejection: title is required');
  });

  it('says when the task vanished between the read and the write', async () => {
    update.mockResolvedValueOnce(null);
    expect(await updateTask.invoke({ task: 't1', completed: true }, BOT_TOOL_CONFIG)).toContain('is gone');
  });
});
