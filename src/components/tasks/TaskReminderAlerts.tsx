'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { isTaskOverdue, useUserTasks } from '@/hooks/useUserTasks';

const STORAGE_KEY = 'tasks:notified';
/** Remembered alerts; older entries fall off so storage stays small. */
const MAX_REMEMBERED = 200;

function readNotified(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeNotified(keys: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys.slice(-MAX_REMEMBERED)));
  } catch {
    // Private mode / quota — worst case an alert repeats after a reload.
  }
}

/**
 * In-app half of task reminders: while the app is open, a toast — and a
 * system notification when the browser has granted permission — the moment a
 * task's reminder passes. The email half is `/api/cron/task-reminders`.
 *
 * Each (task, reminder time) pair alerts once per browser; rescheduling makes
 * a new pair, so it alerts again. Mount once per shell; renders nothing.
 */
export function TaskReminderAlerts() {
  const { tasks, now } = useUserTasks();

  useEffect(() => {
    const due = tasks.filter((t) => isTaskOverdue(t, now) && !t.id.startsWith('temp-'));
    if (due.length === 0) return;

    const notified = readNotified();
    const seen = new Set(notified);
    const fresh = due.filter((t) => !seen.has(`${t.id}|${t.remindAt}`));
    if (fresh.length === 0) return;

    for (const task of fresh) {
      toast(`Reminder: ${task.title}`, { description: 'This task is due.' });
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification('Task reminder', { body: task.title, tag: `task-${task.id}` });
        } catch {
          // Some mobile browsers only allow notifications from a service worker.
        }
      }
    }
    writeNotified([...notified, ...fresh.map((t) => `${t.id}|${t.remindAt}`)]);
  }, [tasks, now]);

  return null;
}
