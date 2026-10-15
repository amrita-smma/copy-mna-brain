import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserTaskService, UserTaskValidationError } from './userTaskService';

const mocks = vi.hoisted(() => ({
  listForUser: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  claimDueReminders: vi.fn(),
  releaseReminders: vi.fn(),
  findByIds: vi.fn(),
  findWorkspace: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('@/lib/queue', () => ({ enqueueSendEmail: vi.fn() }));

class MockTaskRepo {
  listForUser = mocks.listForUser;
  create = mocks.create;
  update = mocks.update;
  delete = mocks.delete;
  claimDueReminders = mocks.claimDueReminders;
  releaseReminders = mocks.releaseReminders;
}
class MockUserRepo {
  findByIds = mocks.findByIds;
}
class MockWorkspaceRepo {
  findById = mocks.findWorkspace;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    workspace_id: 'ws-1',
    user_id: 'u1',
    title: 'Call banker',
    remind_at: null,
    reminder_sent_at: null,
    completed_at: null,
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function makeService() {
  return new UserTaskService(
    new MockTaskRepo() as never,
    new MockUserRepo() as never,
    new MockWorkspaceRepo() as never,
    'ws-1',
    mocks.enqueue,
    'https://app.example.com',
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
});

describe('UserTaskService.list', () => {
  it('maps rows to the camelCase DTO', async () => {
    mocks.listForUser.mockResolvedValue([row({ remind_at: '2026-10-16T09:00:00.000Z' })]);

    const tasks = await makeService().list('u1');

    expect(tasks).toEqual([
      {
        id: 't1',
        title: 'Call banker',
        remindAt: '2026-10-16T09:00:00.000Z',
        completedAt: null,
        createdAt: '2026-10-15T00:00:00.000Z',
      },
    ]);
    expect(mocks.listForUser).toHaveBeenCalledWith('u1', { openLimit: 500, completedLimit: 20 });
  });
});

describe('UserTaskService.create', () => {
  it('trims the title and normalizes the reminder to ISO', async () => {
    mocks.create.mockResolvedValue(row());

    await makeService().create('u1', { title: '  Call banker  ', remindAt: '2026-10-16T09:00:00+07:00' });

    expect(mocks.create).toHaveBeenCalledWith('u1', {
      title: 'Call banker',
      remind_at: '2026-10-16T02:00:00.000Z',
    });
  });

  it('rejects a blank title', async () => {
    await expect(makeService().create('u1', { title: '   ' })).rejects.toBeInstanceOf(
      UserTaskValidationError,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects an unparseable reminder', async () => {
    await expect(
      makeService().create('u1', { title: 'x', remindAt: 'tomorrow-ish' }),
    ).rejects.toBeInstanceOf(UserTaskValidationError);
  });
});

describe('UserTaskService.update', () => {
  it('stamps completed_at when completing and clears it when reopening', async () => {
    mocks.update.mockResolvedValue(row());
    const svc = makeService();

    await svc.update('u1', 't1', { completed: true });
    expect(mocks.update.mock.calls[0][2].completed_at).toEqual(expect.any(String));

    await svc.update('u1', 't1', { completed: false });
    expect(mocks.update.mock.calls[1][2]).toEqual({ completed_at: null });
  });

  it('clears reminder_sent_at when the reminder moves so it fires again', async () => {
    mocks.update.mockResolvedValue(row());

    await makeService().update('u1', 't1', { remindAt: '2026-10-20T09:00:00.000Z' });

    expect(mocks.update).toHaveBeenCalledWith('t1', 'u1', {
      remind_at: '2026-10-20T09:00:00.000Z',
      reminder_sent_at: null,
    });
  });

  it('returns null when the task is not the user’s', async () => {
    mocks.update.mockResolvedValue(null);

    await expect(makeService().update('u1', 't1', { title: 'x' })).resolves.toBeNull();
  });

  it('rejects an empty patch', async () => {
    await expect(makeService().update('u1', 't1', {})).rejects.toBeInstanceOf(
      UserTaskValidationError,
    );
  });
});

describe('UserTaskService.delete', () => {
  it('delegates to the repository with the owning user', async () => {
    mocks.delete.mockResolvedValue(true);

    await expect(makeService().delete('u1', 't1')).resolves.toBe(true);
    expect(mocks.delete).toHaveBeenCalledWith('t1', 'u1');
  });
});

describe('UserTaskService.processDueReminders', () => {
  const now = new Date('2026-10-15T10:00:00.000Z');

  it('does nothing when no reminders are due', async () => {
    mocks.claimDueReminders.mockResolvedValue([]);

    await expect(makeService().processDueReminders(now)).resolves.toEqual({
      reminded: 0,
      notified: 0,
    });
    expect(mocks.claimDueReminders).toHaveBeenCalledWith(now.toISOString(), 200);
    expect(mocks.findByIds).not.toHaveBeenCalled();
  });

  it('resolves owners in one batch and emails each claimed task', async () => {
    mocks.claimDueReminders.mockResolvedValue([
      row({ id: 't1', user_id: 'u1', title: 'A' }),
      row({ id: 't2', user_id: 'u1', title: 'B' }),
      row({ id: 't3', user_id: 'u2', title: 'C' }),
    ]);
    mocks.findByIds.mockResolvedValue([
      { id: 'u1', name: 'One', email: 'one@x.com' },
      { id: 'u2', name: 'Two', email: 'two@x.com' },
    ]);
    mocks.findWorkspace.mockResolvedValue({ id: 'ws-1', slug: 'togan' });
    mocks.enqueue.mockResolvedValue({ messageId: 'm' });

    const result = await makeService().processDueReminders(now);

    expect(result).toEqual({ reminded: 3, notified: 3 });
    expect(mocks.findByIds).toHaveBeenCalledTimes(1);
    expect(mocks.findByIds).toHaveBeenCalledWith(['u1', 'u2']);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      kind: 'task_reminder',
      to: 'one@x.com',
      taskTitle: 'A',
      tasksUrl: 'https://app.example.com/w/togan/profile?tab=items',
    });
    expect(mocks.releaseReminders).toHaveBeenCalledWith([], now.toISOString());
  });

  it('releases a task whose enqueue fails so the next sweep retries it', async () => {
    mocks.claimDueReminders.mockResolvedValue([
      row({ id: 't1', user_id: 'u1' }),
      row({ id: 't2', user_id: 'u1' }),
    ]);
    mocks.findByIds.mockResolvedValue([{ id: 'u1', name: 'One', email: 'one@x.com' }]);
    mocks.findWorkspace.mockResolvedValue(undefined);
    mocks.enqueue.mockRejectedValueOnce(new Error('queue down')).mockResolvedValueOnce({ messageId: 'm' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await makeService().processDueReminders(now);

    expect(result).toEqual({ reminded: 1, notified: 1 });
    expect(mocks.releaseReminders).toHaveBeenCalledWith(['t1'], now.toISOString());
  });

  it('keeps the claim on a task whose owner has no email, without sending', async () => {
    mocks.claimDueReminders.mockResolvedValue([row({ id: 't1', user_id: 'gone' })]);
    mocks.findByIds.mockResolvedValue([]);
    mocks.findWorkspace.mockResolvedValue(undefined);

    const result = await makeService().processDueReminders(now);

    expect(result).toEqual({ reminded: 1, notified: 0 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.releaseReminders).toHaveBeenCalledWith([], now.toISOString());
  });
});
