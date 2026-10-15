'use client';

import { useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatReminder, reminderPresets, toDateTimeLocal } from './reminderTime';

/**
 * Ask for browser-notification permission the first time someone sets a
 * reminder — inside the click, which is the only moment browsers allow it.
 */
function requestNotificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'default') void Notification.requestPermission();
}

/**
 * The bell on a task: a small popover of quick picks plus a date-and-time
 * field. The trigger is whatever the caller renders (`children`), so the
 * quick-add bar and a task row can each style it their own way.
 */
export function ReminderPicker({
  value,
  onChange,
  children,
  align = 'end',
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
  children: React.ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');

  const pick = (iso: string | null) => {
    if (iso) requestNotificationPermission();
    onChange(iso);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setCustom(value ? toDateTimeLocal(new Date(value)) : '');
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-60 p-1.5" data-testid="task-reminder-picker">
        <div className="flex flex-col">
          {reminderPresets().map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => pick(preset.at.toISOString())}
              className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm hover:bg-accent"
            >
              <span>{preset.label}</span>
              <span className="text-xs text-muted-foreground">
                {formatReminder(preset.at.toISOString())}
              </span>
            </button>
          ))}
        </div>
        <form
          className="mt-1.5 flex items-center gap-1.5 border-t px-1 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            const date = new Date(custom);
            if (!custom || Number.isNaN(date.getTime())) return;
            pick(date.toISOString());
          }}
        >
          <input
            type="datetime-local"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Reminder date and time"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
          />
          <button
            type="submit"
            disabled={!custom}
            className="h-8 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Set
          </button>
        </form>
        {value && (
          <button
            type="button"
            onClick={() => pick(null)}
            className="mt-1.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <BellOff className="h-3.5 w-3.5" />
            Remove reminder
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The chip a task shows for its reminder — red once it has passed. */
export function ReminderChip({
  remindAt,
  overdue,
  className,
}: {
  remindAt: string;
  overdue: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        overdue ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground',
        className,
      )}
    >
      <Bell className="h-3 w-3" />
      {formatReminder(remindAt)}
    </span>
  );
}
