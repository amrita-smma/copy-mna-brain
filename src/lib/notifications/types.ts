export type NotificationSeverity = 'critical' | 'warning' | 'info' | 'neutral';

export type NotificationKind =
  | 'request_timeout'
  | 'session_expired'
  | 'data_source_degraded'
  | 'incomplete_financials'
  | 'strategy_conflict'
  | 'borderline_result'
  | 'duplicate_record'
  | 'task_queued';

export interface NotificationAction {
  id: string;
  label: string;
  // 'href' navigates the user; 'event' is a logical id the client component
  // maps to a behaviour (retry, skip, dismiss, etc.).
  kind: 'href' | 'event';
  href?: string;
  event?: string;
}

export interface TaskNotification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  description: string;
  actions: NotificationAction[];
  dismissible: boolean;
  // Client-side auto-dismiss timer. Null = stays until the user closes it
  // (critical errors must require an action).
  autoDismissMs: number | null;
  dismissedAt: string | null;
  createdAt: string;
}

// Shape persisted in ai_workforce_queue.error jsonb. The dispatcher reads
// and writes the `notifications` array; any other keys (e.g. the existing
// `code: 'cancelled_by_user'` marker) are preserved untouched.
export interface TaskErrorPayload {
  notifications?: TaskNotification[];
  [key: string]: unknown;
}
