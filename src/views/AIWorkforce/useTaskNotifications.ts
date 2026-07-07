'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '@/lib/api/client';
import { NOTIFICATION_DEFS } from '@/lib/notifications/registry';
import type {
  NotificationAction,
  TaskNotification,
} from '@/lib/notifications/types';

// Session-expired is detected client-side from a 401 on the trace poll —
// once the session is gone the user can't fetch persisted notifications,
// so this one only ever lives in client state. A stable id keeps the
// notification idempotent across re-renders.
const SESSION_EXPIRED_ID = 'client-session-expired';

interface UseTaskNotificationsOptions {
  taskId: string | null;
  serverNotifications: TaskNotification[];
}

interface UseTaskNotificationsReturn {
  notifications: TaskNotification[];
  handleAction: (n: TaskNotification, a: NotificationAction) => void;
  handleDismiss: (n: TaskNotification) => Promise<void>;
  setSessionExpired: () => void;
}

export function useTaskNotifications({
  taskId,
  serverNotifications,
}: UseTaskNotificationsOptions): UseTaskNotificationsReturn {
  const [clientNotifications, setClientNotifications] = useState<
    TaskNotification[]
  >([]);
  // Optimistic dismiss: hide server notifications immediately while the
  // dismiss POST is in flight, rollback on failure.
  const [pendingDismiss, setPendingDismiss] = useState<Set<string>>(new Set());

  const handleDismiss = useCallback(
    async (n: TaskNotification): Promise<void> => {
      if (n.id === SESSION_EXPIRED_ID) {
        setClientNotifications((prev) => prev.filter((x) => x.id !== n.id));
        return;
      }
      if (!taskId) return;
      setPendingDismiss((prev) => new Set(prev).add(n.id));
      try {
        await apiRequest(`/api/workforce-queue/${taskId}/notifications/${n.id}/dismiss`, {
          method: 'POST',
        });
      } catch (err) {
        setPendingDismiss((prev) => {
          const next = new Set(prev);
          next.delete(n.id);
          return next;
        });
        console.error('[useTaskNotifications] dismiss failed:', err);
      }
    },
    [taskId],
  );

  const handleAction = useCallback(
    (n: TaskNotification, a: NotificationAction): void => {
      if (a.kind === 'href' && a.href) {
        window.location.href = a.href;
        return;
      }
      if (a.event === 'dismiss') {
        void handleDismiss(n);
      }
      // Other events are owned by the feature that dispatches the notification
      // (retry/skip/merge/etc.). They no-op here so the UI is reusable.
    },
    [handleDismiss],
  );

  const setSessionExpired = useCallback((): void => {
    setClientNotifications((prev) => {
      if (prev.some((n) => n.id === SESSION_EXPIRED_ID)) return prev;
      const def = NOTIFICATION_DEFS.session_expired;
      const n: TaskNotification = {
        id: SESSION_EXPIRED_ID,
        kind: 'session_expired',
        severity: def.severity,
        title: def.defaultTitle,
        description: def.defaultDescription,
        actions: def.defaultActions,
        dismissible: def.dismissible,
        autoDismissMs: def.autoDismissMs,
        dismissedAt: null,
        createdAt: new Date().toISOString(),
      };
      return [...prev, n];
    });
  }, []);

  // Clear pending-dismiss entries once the server has caught up (the next
  // poll tick will omit the dismissed notification from serverNotifications).
  useEffect(() => {
    setPendingDismiss((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (!serverNotifications.some((n) => n.id === id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [serverNotifications]);

  useEffect(() => {
    setClientNotifications([]);
    setPendingDismiss(new Set());
  }, [taskId]);

  const notifications = useMemo(
    () => [
      ...clientNotifications,
      ...serverNotifications.filter((n) => !pendingDismiss.has(n.id)),
    ],
    [clientNotifications, serverNotifications, pendingDismiss],
  );

  return { notifications, handleAction, handleDismiss, setSessionExpired };
}
