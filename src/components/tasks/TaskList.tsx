'use client';

import { useState } from 'react';
import { Bell, Check, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isTaskOverdue, useUserTasks } from '@/hooks/useUserTasks';
import type { UserTask } from '@/lib/api/tasks';
import { ReminderChip, ReminderPicker } from './ReminderPicker';

/** Ids the client minted for a task the server has not confirmed yet. */
const isPending = (task: UserTask) => task.id.startsWith('temp-');

/**
 * A plain to-do list: type and press Enter to add, tick the circle to finish,
 * click a title to rename it, and the bell to set a reminder. Completed tasks
 * fold away under a toggle so the open list stays the focus.
 *
 * Backed by `useUserTasks`, so every place it is mounted (Profile, the
 * sidebar popover) shares one cache.
 */
export function TaskList({ className }: { className?: string }) {
  const { tasks, now, loading, addTask, editTask, removeTask } = useUserTasks();
  const [showCompleted, setShowCompleted] = useState(false);

  const open = tasks.filter((t) => !t.completedAt);
  const done = tasks.filter((t) => t.completedAt);

  return (
    <div className={cn('flex flex-col', className)} data-testid="task-list">
      <QuickAdd onAdd={addTask} />

      {loading ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">Loading tasks…</p>
      ) : (
        <ul className="flex flex-col">
          {open.map((task) => (
            <TaskRow key={task.id} task={task} now={now} onEdit={editTask} onDelete={removeTask} />
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowCompleted((v) => !v)}
            className="flex items-center gap-1 px-1 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            data-testid="task-list-toggle-completed"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', showCompleted && 'rotate-90')}
            />
            Completed ({done.length})
          </button>
          {showCompleted && (
            <ul className="flex flex-col">
              {done.map((task) => (
                <TaskRow key={task.id} task={task} now={now} onEdit={editTask} onDelete={removeTask} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function QuickAdd({ onAdd }: { onAdd: (title: string, remindAt: string | null) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [remindAt, setRemindAt] = useState<string | null>(null);

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    void onAdd(trimmed, remindAt);
    setTitle('');
    setRemindAt(null);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring"
    >
      <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a task"
        maxLength={500}
        aria-label="New task"
        data-testid="task-add-input"
        className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {remindAt && <ReminderChip remindAt={remindAt} overdue={false} className="shrink-0" />}
      <ReminderPicker value={remindAt} onChange={setRemindAt}>
        <button
          type="button"
          aria-label={remindAt ? 'Change reminder' : 'Add reminder'}
          title="Remind me"
          data-testid="task-add-reminder"
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent',
            remindAt ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <Bell className="h-3.5 w-3.5" />
        </button>
      </ReminderPicker>
    </form>
  );
}

function TaskRow({
  task,
  now,
  onEdit,
  onDelete,
}: {
  task: UserTask;
  now: number;
  onEdit: (id: string, update: { title?: string; remindAt?: string | null; completed?: boolean }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const done = !!task.completedAt;
  const pending = isPending(task);
  const overdue = isTaskOverdue(task, now);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== task.title) void onEdit(task.id, { title: trimmed });
    else setDraft(task.title);
  };

  return (
    <li
      className={cn('group flex items-start gap-2.5 border-b px-1 py-2 last:border-b-0', pending && 'opacity-60')}
      data-testid={`task-row-${task.id}`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
        disabled={pending}
        onClick={() => void onEdit(task.id, { completed: !done })}
        className={cn(
          'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors',
          done
            ? 'border-primary bg-primary text-primary-foreground'
            : overdue
              ? 'border-red-500 hover:bg-red-50 dark:hover:bg-red-950'
              : 'border-muted-foreground/50 hover:border-primary',
        )}
      >
        <Check className={cn('h-3 w-3', done ? 'opacity-100' : 'opacity-0 group-hover:opacity-40')} />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {editing ? (
          <input
            autoFocus
            value={draft}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(task.title);
                setEditing(false);
              }
            }}
            aria-label="Task title"
            className="h-6 bg-transparent text-sm outline-none"
          />
        ) : (
          <button
            type="button"
            disabled={pending || done}
            onClick={() => {
              setDraft(task.title);
              setEditing(true);
            }}
            className={cn(
              'break-words text-left text-sm leading-snug',
              done && 'text-muted-foreground line-through',
            )}
          >
            {task.title}
          </button>
        )}
        {task.remindAt && !done && <ReminderChip remindAt={task.remindAt} overdue={overdue} />}
      </div>

      {!pending && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
          {!done && (
            <ReminderPicker
              value={task.remindAt}
              onChange={(remindAt) => void onEdit(task.id, { remindAt })}
            >
              <button
                type="button"
                aria-label="Set reminder"
                title="Remind me"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Bell className="h-3.5 w-3.5" />
              </button>
            </ReminderPicker>
          )}
          <button
            type="button"
            aria-label={`Delete "${task.title}"`}
            title="Delete"
            onClick={() => void onDelete(task.id)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </li>
  );
}
