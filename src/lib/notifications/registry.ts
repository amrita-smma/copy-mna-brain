import {
  AlertTriangle,
  BarChart3,
  Clock,
  Copy,
  Database,
  GitBranch,
  ListTodo,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import type {
  NotificationAction,
  NotificationKind,
  NotificationSeverity,
} from './types';

export interface NotificationDefinition {
  severity: NotificationSeverity;
  icon: LucideIcon;
  defaultTitle: string;
  defaultDescription: string;
  defaultActions: NotificationAction[];
  // 'stacked' = buttons in a column (default).
  // 'row-then-stack' = first two buttons side-by-side, remaining stacked
  // below (matches the Borderline result design).
  actionLayout: 'stacked' | 'row-then-stack';
  // Null = no auto-dismiss; the user must close it. Used for criticals.
  autoDismissMs: number | null;
  dismissible: boolean;
}

export const NOTIFICATION_DEFS: Record<NotificationKind, NotificationDefinition> = {
  request_timeout: {
    severity: 'critical',
    icon: Clock,
    defaultTitle: 'Request timed out',
    defaultDescription: 'The upstream call did not respond in time.',
    defaultActions: [
      { id: 'retry', label: 'Retry step', kind: 'event', event: 'retry' },
      { id: 'skip', label: 'Skip & continue', kind: 'event', event: 'skip' },
    ],
    actionLayout: 'stacked',
    autoDismissMs: null,
    dismissible: true,
  },
  session_expired: {
    severity: 'critical',
    icon: Lock,
    defaultTitle: 'Session expired',
    defaultDescription:
      'Your session has expired. Re-authenticate to resume the task.',
    defaultActions: [
      { id: 'reauth', label: 'Re-authenticate', kind: 'href', href: '/login' },
      { id: 'dismiss', label: 'Dismiss', kind: 'event', event: 'dismiss' },
    ],
    actionLayout: 'stacked',
    autoDismissMs: null,
    dismissible: true,
  },
  data_source_degraded: {
    severity: 'warning',
    icon: Database,
    defaultTitle: 'Data source degraded',
    defaultDescription: 'The data source is returning partial results.',
    defaultActions: [
      { id: 'use_cached', label: 'Use cached data', kind: 'event', event: 'use_cached' },
      { id: 'pause', label: 'Pause task', kind: 'event', event: 'pause' },
    ],
    actionLayout: 'stacked',
    autoDismissMs: null,
    dismissible: true,
  },
  incomplete_financials: {
    severity: 'warning',
    icon: BarChart3,
    defaultTitle: 'Incomplete financials',
    defaultDescription: 'Financial data is missing for one or more entries.',
    defaultActions: [
      { id: 'upload', label: 'Upload manually', kind: 'event', event: 'upload' },
      { id: 'flag', label: 'Flag & continue', kind: 'event', event: 'flag' },
    ],
    actionLayout: 'stacked',
    autoDismissMs: null,
    dismissible: true,
  },
  strategy_conflict: {
    severity: 'warning',
    icon: GitBranch,
    defaultTitle: 'Strategy logic conflict',
    defaultDescription: 'Two rules in the active strategy contradict each other.',
    defaultActions: [
      { id: 'review', label: 'Review criteria', kind: 'event', event: 'review' },
      { id: 'use_latest', label: 'Use latest version', kind: 'event', event: 'use_latest' },
    ],
    actionLayout: 'stacked',
    autoDismissMs: null,
    dismissible: true,
  },
  borderline_result: {
    severity: 'warning',
    icon: AlertTriangle,
    defaultTitle: 'Borderline result — your call',
    defaultDescription: 'A result fell within the margin of error for its threshold.',
    defaultActions: [
      { id: 'accept', label: 'Accept anyway', kind: 'event', event: 'accept' },
      { id: 'drop', label: 'Drop it', kind: 'event', event: 'drop' },
      { id: 'monitor', label: 'Monitor', kind: 'event', event: 'monitor' },
    ],
    actionLayout: 'row-then-stack',
    autoDismissMs: null,
    dismissible: true,
  },
  duplicate_record: {
    severity: 'info',
    icon: Copy,
    defaultTitle: 'Duplicate record detected',
    defaultDescription: 'A record with the same identifier already exists.',
    defaultActions: [
      { id: 'merge', label: 'Merge records', kind: 'event', event: 'merge' },
      { id: 'separate', label: 'Keep separate', kind: 'event', event: 'separate' },
    ],
    actionLayout: 'stacked',
    autoDismissMs: null,
    dismissible: true,
  },
  task_queued: {
    severity: 'neutral',
    icon: ListTodo,
    defaultTitle: 'Task added to queue',
    defaultDescription: 'The task is queued and will start shortly.',
    defaultActions: [
      { id: 'view_queue', label: 'View queue', kind: 'href', href: '/ai-workforce' },
    ],
    actionLayout: 'stacked',
    autoDismissMs: 8000,
    dismissible: true,
  },
};
