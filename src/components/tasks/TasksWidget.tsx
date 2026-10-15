'use client';

import { useState } from 'react';
import { ListChecks } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { cn } from '@/lib/utils';
import { isTaskOverdue, useUserTasks } from '@/hooks/useUserTasks';
import { TaskList } from './TaskList';

/**
 * The tasks button beside the "what's new" bell in the sidebar footer. Opens
 * the same to-do list Profile → "Needs your attention" shows, so a task can be
 * jotted down from any page. A red count marks reminders that have passed.
 */
export function TasksWidget() {
  const [open, setOpen] = useState(false);
  const { tasks, now } = useUserTasks();
  const overdue = tasks.filter((t) => isTaskOverdue(t, now)).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={overdue ? `Tasks, ${overdue} overdue` : 'Tasks'}
          title="Tasks"
          data-testid="sidebar-tasks-button"
          className={cn(
            'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors',
            'hover:bg-sidebar-accent hover:text-sidebar-foreground',
          )}
        >
          <ListChecks className="h-4 w-4" />
          {overdue > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white">
              {overdue > 9 ? '9+' : overdue}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">Tasks</p>
          <WorkspaceLink
            href="/profile?tab=items"
            onClick={() => setOpen(false)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            View all
          </WorkspaceLink>
        </div>
        <div className="max-h-96 overflow-y-auto p-3">
          <TaskList />
        </div>
      </PopoverContent>
    </Popover>
  );
}
