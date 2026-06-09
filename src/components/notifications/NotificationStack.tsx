'use client';

import { Notification } from './Notification';
import type {
  NotificationAction,
  TaskNotification,
} from '@/lib/notifications/types';

interface NotificationStackProps {
  notifications: TaskNotification[];
  onAction: (notification: TaskNotification, action: NotificationAction) => void;
  onDismiss: (notification: TaskNotification) => void;
}

export function NotificationStack({
  notifications,
  onAction,
  onDismiss,
}: NotificationStackProps) {
  if (notifications.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      {notifications.map((n) => (
        <Notification
          key={n.id}
          notification={n}
          onAction={onAction}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
