import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiWorkforceQueueRepository } from '@/lib/repositories';
import { NotificationService } from './notificationService';
import type { TaskNotification } from '@/lib/notifications/types';

function makeQueueRepoStub(): AiWorkforceQueueRepository {
  return {
    addNotification: vi.fn(),
    dismissNotification: vi.fn(),
    listNotifications: vi.fn(),
    findById: vi.fn(),
  } as unknown as AiWorkforceQueueRepository;
}

describe('NotificationService', () => {
  let queueRepo: AiWorkforceQueueRepository;
  let service: NotificationService;

  beforeEach(() => {
    queueRepo = makeQueueRepoStub();
    service = new NotificationService(queueRepo);
  });

  describe('build', () => {
    it('hydrates a TaskNotification from the registry defaults', () => {
      const n = service.build('request_timeout');
      expect(n.kind).toBe('request_timeout');
      expect(n.severity).toBe('critical');
      expect(n.title).toBe('Request timed out');
      expect(n.autoDismissMs).toBeNull();
      expect(n.dismissedAt).toBeNull();
      expect(n.dismissible).toBe(true);
      expect(n.actions.map((a) => a.id)).toEqual(['retry', 'skip']);
      expect(n.id).toMatch(/[0-9a-f-]{36}/);
    });

    it('applies title and description overrides', () => {
      const n = service.build('request_timeout', {
        title: 'Custom title',
        description: 'Custom description',
      });
      expect(n.title).toBe('Custom title');
      expect(n.description).toBe('Custom description');
    });

    it('marks critical kinds with no autoDismissMs', () => {
      expect(service.build('request_timeout').autoDismissMs).toBeNull();
      expect(service.build('session_expired').autoDismissMs).toBeNull();
    });

    it('marks task_queued with an auto-dismiss timer', () => {
      expect(service.build('task_queued').autoDismissMs).toBe(8000);
    });
  });

  describe('dispatch', () => {
    it('persists the notification via the queue repository and returns it', async () => {
      vi.mocked(queueRepo.addNotification).mockResolvedValue({} as never);

      const n = await service.dispatch('task-1', 'request_timeout', {
        description: 'CapIQ did not respond within 30s.',
      });

      expect(queueRepo.addNotification).toHaveBeenCalledTimes(1);
      const [taskId, persisted] = vi.mocked(queueRepo.addNotification).mock.calls[0];
      expect(taskId).toBe('task-1');
      expect((persisted as TaskNotification).id).toBe(n.id);
      expect((persisted as TaskNotification).description).toBe(
        'CapIQ did not respond within 30s.',
      );
    });
  });

  describe('dismiss', () => {
    it('delegates to the queue repository', async () => {
      vi.mocked(queueRepo.dismissNotification).mockResolvedValue({} as never);
      await service.dismiss('task-1', 'notif-1');
      expect(queueRepo.dismissNotification).toHaveBeenCalledWith(
        'task-1',
        'notif-1',
      );
    });
  });

  describe('list', () => {
    it('returns [] when the task does not exist', async () => {
      vi.mocked(queueRepo.findById).mockResolvedValue(null);
      const result = await service.list('missing');
      expect(result).toEqual([]);
      expect(queueRepo.listNotifications).not.toHaveBeenCalled();
    });

    it('reads notifications from the row via listNotifications', async () => {
      const row = { id: 'task-1' } as never;
      const notes: TaskNotification[] = [
        {
          id: 'n-1',
          kind: 'request_timeout',
          severity: 'critical',
          title: 'x',
          description: 'y',
          actions: [],
          dismissible: true,
          autoDismissMs: null,
          dismissedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];
      vi.mocked(queueRepo.findById).mockResolvedValue(row);
      vi.mocked(queueRepo.listNotifications).mockReturnValue(notes);

      const result = await service.list('task-1');

      expect(result).toEqual(notes);
      expect(queueRepo.listNotifications).toHaveBeenCalledWith(row, {
        includeDismissed: false,
      });
    });

    it('forwards the includeDismissed flag', async () => {
      const row = { id: 'task-1' } as never;
      vi.mocked(queueRepo.findById).mockResolvedValue(row);
      vi.mocked(queueRepo.listNotifications).mockReturnValue([]);

      await service.list('task-1', { includeDismissed: true });

      expect(queueRepo.listNotifications).toHaveBeenCalledWith(row, {
        includeDismissed: true,
      });
    });
  });
});
