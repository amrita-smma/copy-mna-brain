import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ userTaskService: { create } })) }));

import { createTask } from './create_task';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';
import { UserTaskValidationError } from '@/lib/services/userTaskService';

describe('create_task', () => {
  // The tool describes the new task against the real clock; pin it so a
  // reminder in the fixture stays in the future.
  beforeEach(() => {
    create.mockReset();
    vi.useFakeTimers({ now: new Date('2026-10-21T10:00:00.000Z'), toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('adds the task for the chatting user, with the reminder when given, and says so', async () => {
    create.mockResolvedValue({ id: 't9', title: 'Call Budi', remindAt: '2026-10-22T02:00:00.000Z', completedAt: null, createdAt: 'c' });

    const out = (await createTask.invoke({ title: 'Call Budi', remind_at: '2026-10-22T09:00:00+07:00' }, BOT_TOOL_CONFIG)) as string;

    expect(create).toHaveBeenCalledWith('u1', { title: 'Call Budi', remindAt: '2026-10-22T09:00:00+07:00' });
    expect(out).toContain('Added to the user\'s tasks: Call Budi — due 2026-10-22T02:00:00.000Z (id t9).');
    expect(out).toContain('reminded in the app and by email');
  });

  it('passes no reminder when none was given, and relays a validation error as a rejection', async () => {
    create.mockResolvedValueOnce({ id: 't9', title: 'x', remindAt: null, completedAt: null, createdAt: 'c' });
    await createTask.invoke({ title: 'x' }, BOT_TOOL_CONFIG);
    expect(create).toHaveBeenCalledWith('u1', { title: 'x', remindAt: null });
    create.mockRejectedValueOnce(new UserTaskValidationError('remindAt must be an ISO date string'));
    expect(await createTask.invoke({ title: 'x', remind_at: 'tomorrow' }, BOT_TOOL_CONFIG)).toBe('Rejection: remindAt must be an ISO date string');
  });
});
