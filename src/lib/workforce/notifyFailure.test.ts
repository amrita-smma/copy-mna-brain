import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notifyTaskFailed, routinesCtor } = vi.hoisted(() => ({
  notifyTaskFailed: vi.fn(),
  routinesCtor: vi.fn(),
}));

vi.mock('@/lib/services/emailNotificationService', () => ({
  EmailNotificationService: class {
    notifyTaskFailed = notifyTaskFailed;
  },
}));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockRoutinesRepository {
    constructor(_db: unknown, workspaceId: string) {
      routinesCtor(workspaceId);
    }
  }
  return { ...actual, RoutinesRepository: MockRoutinesRepository };
});

import { notifyRunFailed } from './notifyFailure';

describe('notifyRunFailed', () => {
  beforeEach(() => {
    notifyTaskFailed.mockReset().mockResolvedValue(true);
    routinesCtor.mockReset();
  });

  it('sends a non-cancellation failure email with the reason', async () => {
    expect(await notifyRunFailed({} as never, 'ws-1', 'run-1', 'stuck')).toBe(true);
    expect(notifyTaskFailed).toHaveBeenCalledWith('run-1', { cancelled: false, reason: 'stuck' });
  });

  it("scopes the recipient lookup to the run's own workspace", async () => {
    await notifyRunFailed({} as never, 'ws-9', 'run-1', undefined);
    expect(routinesCtor).toHaveBeenCalledWith('ws-9');
  });
});
