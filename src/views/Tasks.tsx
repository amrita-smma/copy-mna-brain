'use client';

import { AlertCircle } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { TaskList } from '@/components/tasks/TaskList';
import { isTaskOverdue, useUserTasks } from '@/hooks/useUserTasks';

/**
 * Your tasks, full page: the same list as the Profile tab and the sidebar
 * popover (one react-query cache), under the shared page header. A red count
 * beside the title says how many reminders have passed. On mobile the shell
 * floats the back button over it.
 */
export default function Tasks() {
  const { tasks, now, loading } = useUserTasks();
  const open = tasks.filter((t) => !t.completedAt).length;
  const overdue = tasks.filter((t) => isTaskOverdue(t, now)).length;

  return (
    <div className="min-h-full" data-testid="tasks-page">
      <PageHeader
        title="Your tasks"
        subtitle={
          loading
            ? 'Your personal to-do list in this workspace.'
            : open === 0
              ? 'Nothing open. Add a task below; set a reminder and it reaches you by email too.'
              : `${open} open task${open === 1 ? '' : 's'} in this workspace. Only you see them.`
        }
        titleAdornment={
          overdue > 0 ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-red-500 px-2 py-0.5 text-xs font-semibold text-white"
              data-testid="tasks-overdue-count"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              {overdue} overdue
            </span>
          ) : undefined
        }
      />
      <div className="mx-auto w-full max-w-2xl px-6 pb-8">
        <TaskList />
      </div>
    </div>
  );
}
