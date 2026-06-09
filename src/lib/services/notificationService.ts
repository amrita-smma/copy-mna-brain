import { randomUUID } from 'crypto';
import type { AiWorkforceQueueRepository } from '@/lib/repositories';
import { NOTIFICATION_DEFS } from '@/lib/notifications/registry';
import type {
  NotificationKind,
  TaskNotification,
} from '@/lib/notifications/types';

export interface DispatchOptions {
  title?: string;
  description?: string;
}

export class NotificationService {
  constructor(private readonly queueRepo: AiWorkforceQueueRepository) {}

  // Builds a TaskNotification from the registry definition plus any per-call
  // overrides (e.g. interpolating the upstream service name into the title).
  build(kind: NotificationKind, overrides: DispatchOptions = {}): TaskNotification {
    const def = NOTIFICATION_DEFS[kind];
    return {
      id: randomUUID(),
      kind,
      severity: def.severity,
      title: overrides.title ?? def.defaultTitle,
      description: overrides.description ?? def.defaultDescription,
      actions: def.defaultActions,
      dismissible: def.dismissible,
      autoDismissMs: def.autoDismissMs,
      dismissedAt: null,
      createdAt: new Date().toISOString(),
    };
  }

  async dispatch(
    taskId: string,
    kind: NotificationKind,
    overrides: DispatchOptions = {},
  ): Promise<TaskNotification> {
    const notification = this.build(kind, overrides);
    await this.queueRepo.addNotification(taskId, notification);
    return notification;
  }

  async dismiss(taskId: string, notificationId: string): Promise<void> {
    await this.queueRepo.dismissNotification(taskId, notificationId);
  }

  async list(
    taskId: string,
    { includeDismissed = false } = {},
  ): Promise<TaskNotification[]> {
    const row = await this.queueRepo.findById(taskId);
    if (!row) return [];
    return this.queueRepo.listNotifications(row, { includeDismissed });
  }
}
