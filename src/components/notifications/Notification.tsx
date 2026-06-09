'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NOTIFICATION_DEFS } from '@/lib/notifications/registry';
import type {
  NotificationAction,
  NotificationSeverity,
  TaskNotification,
} from '@/lib/notifications/types';

interface NotificationProps {
  notification: TaskNotification;
  onAction: (notification: TaskNotification, action: NotificationAction) => void;
  onDismiss: (notification: TaskNotification) => void;
}

interface SeverityTokens {
  surface: string;
  title: string;
  body: string;
  icon: string;
  action: string;
  closeButton: string;
}

const SEVERITY_TOKENS: Record<NotificationSeverity, SeverityTokens> = {
  critical: {
    surface: 'border-rose-200 bg-rose-50',
    title: 'text-rose-900',
    body: 'text-rose-700',
    icon: 'text-rose-600',
    action:
      'border-rose-200/80 bg-white text-rose-900 hover:bg-rose-100/60 hover:border-rose-300',
    closeButton:
      'border-rose-200/80 text-rose-600 hover:bg-rose-100 hover:border-rose-300',
  },
  warning: {
    surface: 'border-amber-200 bg-amber-50',
    title: 'text-amber-900',
    body: 'text-amber-800',
    icon: 'text-amber-700',
    action:
      'border-amber-200/80 bg-white text-amber-900 hover:bg-amber-100/60 hover:border-amber-300',
    closeButton:
      'border-amber-200/80 text-amber-700 hover:bg-amber-100 hover:border-amber-300',
  },
  info: {
    surface: 'border-blue-200 bg-blue-50',
    title: 'text-blue-900',
    body: 'text-blue-800',
    icon: 'text-blue-700',
    action:
      'border-blue-200/80 bg-white text-blue-900 hover:bg-blue-100/60 hover:border-blue-300',
    closeButton:
      'border-blue-200/80 text-blue-700 hover:bg-blue-100 hover:border-blue-300',
  },
  neutral: {
    surface: 'border-slate-200 bg-white',
    title: 'text-slate-900',
    body: 'text-slate-600',
    icon: 'text-slate-500',
    action:
      'border-slate-200 bg-white text-slate-900 hover:bg-slate-50 hover:border-slate-300',
    closeButton:
      'border-slate-200 text-slate-500 hover:bg-slate-50 hover:border-slate-300',
  },
};

export function Notification({
  notification,
  onAction,
  onDismiss,
}: NotificationProps) {
  const def = NOTIFICATION_DEFS[notification.kind];
  const tokens = SEVERITY_TOKENS[notification.severity];
  const Icon = def.icon;

  useEffect(() => {
    if (notification.autoDismissMs === null) return;
    const handle = window.setTimeout(() => {
      onDismiss(notification);
    }, notification.autoDismissMs);
    return () => window.clearTimeout(handle);
  }, [notification, onDismiss]);

  const actions = notification.actions;
  const layout = def.actionLayout;
  const showRowThenStack = layout === 'row-then-stack' && actions.length >= 3;

  return (
    <div
      role={notification.severity === 'critical' ? 'alert' : 'status'}
      className={cn(
        'flex gap-3 rounded-xl border px-4 py-3.5 shadow-sm',
        tokens.surface,
      )}
    >
      <Icon
        className={cn('h-5 w-5 mt-0.5 flex-shrink-0', tokens.icon)}
        strokeWidth={2}
      />
      <div className="flex-1 min-w-0">
        <h4 className={cn('text-sm font-semibold leading-tight', tokens.title)}>
          {notification.title}
        </h4>
        <p className={cn('mt-1 text-sm leading-snug', tokens.body)}>
          {notification.description}
        </p>
        {actions.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {showRowThenStack ? (
              <>
                <div className="flex gap-2">
                  {actions.slice(0, 2).map((action) => (
                    <ActionButton
                      key={action.id}
                      action={action}
                      tokens={tokens}
                      onClick={() => onAction(notification, action)}
                    />
                  ))}
                </div>
                {actions.slice(2).map((action) => (
                  <ActionButton
                    key={action.id}
                    action={action}
                    tokens={tokens}
                    onClick={() => onAction(notification, action)}
                  />
                ))}
              </>
            ) : (
              actions.map((action) => (
                <ActionButton
                  key={action.id}
                  action={action}
                  tokens={tokens}
                  onClick={() => onAction(notification, action)}
                />
              ))
            )}
          </div>
        )}
      </div>
      {notification.dismissible && (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(notification)}
          className={cn(
            'h-8 w-8 flex-shrink-0 grid place-items-center rounded-lg border transition-colors',
            tokens.closeButton,
          )}
        >
          <X className="h-4 w-4" strokeWidth={2.25} />
        </button>
      )}
    </div>
  );
}

interface ActionButtonProps {
  action: NotificationAction;
  tokens: SeverityTokens;
  onClick: () => void;
}

function ActionButton({ action, tokens, onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center rounded-lg border px-3.5 py-2 text-sm font-semibold transition-colors flex-1',
        tokens.action,
      )}
    >
      {action.label}
    </button>
  );
}
