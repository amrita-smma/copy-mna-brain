import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ userTaskService: { list } })) }));

import { listTasks } from './list_tasks';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';

describe('list_tasks', () => {
  beforeEach(() => list.mockReset());

  it("lists the user's open tasks with their reminders and the current time", async () => {
    list.mockResolvedValue([
      { id: 't1', title: 'Call Budi', remindAt: null, completedAt: null, createdAt: '2026-10-20T08:00:00.000Z' },
      { id: 't2', title: 'Book the room', remindAt: null, completedAt: '2026-10-20T12:00:00.000Z', createdAt: '2026-10-19T08:00:00.000Z' },
    ]);

    const out = (await listTasks.invoke({}, BOT_TOOL_CONFIG)) as string;

    expect(list).toHaveBeenCalledWith('u1');
    expect(out).toMatch(/^Now: \d{4}-/);
    expect(out).toContain('- Call Budi — open, no reminder (id t1)');
    expect(out).toContain('1 completed task not shown');
    expect((await listTasks.invoke({ include_completed: true }, BOT_TOOL_CONFIG)) as string).toContain('- Book the room — done');
  });

  it('only runs for a signed-in user', async () => {
    expect(await listTasks.invoke({}, { configurable: {} })).toContain('only runs inside a Copilot bot chat');
    expect(list).not.toHaveBeenCalled();
  });
});
