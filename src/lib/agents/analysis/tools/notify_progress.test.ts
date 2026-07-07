import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';

const { notifyTaskProgress } = vi.hoisted(() => ({
  notifyTaskProgress: vi.fn(),
}));

vi.mock('@/lib/services/emailNotificationService', () => {
  class MockNotificationService {
    notifyTaskProgress = notifyTaskProgress;
  }
  return { EmailNotificationService: MockNotificationService };
});

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/repositories', () => ({
  AiWorkforceQueueRepository: class {},
  RoutinesRepository: class {},
  UserRepository: class {},
  WorkspaceRepository: class {},
}));

import { notifyProgress } from './notify_progress';

function invoke(args: Record<string, unknown>, config: RunnableConfig | undefined) {
  return notifyProgress.invoke(args, config);
}

describe('notify_progress', () => {
  beforeEach(() => notifyTaskProgress.mockReset());

  it('skips when there is no run context (thread_id)', async () => {
    const result = await invoke({ progress: '47 scanned' }, { configurable: {} });
    expect(String(result)).toMatch(/No run context/);
    expect(notifyTaskProgress).not.toHaveBeenCalled();
  });

  it('forwards progress + headline to EmailNotificationService keyed by thread_id', async () => {
    notifyTaskProgress.mockResolvedValue(true);
    const result = await invoke(
      { progress: '47 companies scanned', headline: '47 companies scanned' },
      { configurable: { thread_id: 'run-1' } },
    );
    expect(notifyTaskProgress).toHaveBeenCalledWith('run-1', {
      progress: '47 companies scanned',
      headline: '47 companies scanned',
    });
    expect(String(result)).toMatch(/emailed/i);
  });

  it('reports when nothing was sent', async () => {
    notifyTaskProgress.mockResolvedValue(false);
    const result = await invoke(
      { progress: 'p' },
      { configurable: { thread_id: 'run-1' } },
    );
    expect(String(result)).toMatch(/not sent/i);
  });
});
