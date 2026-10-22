import type { UserTask } from '@/lib/services/userTaskService';

/**
 * Shared by the task tools (list_tasks, create_task, update_task,
 * delete_task): naming a task, and describing one.
 */

/**
 * The task an argument names: an exact id, else the one task whose title is
 * exactly that (any case), else the one task whose title contains it. Null
 * when nothing — or more than one task — matches, so a vague reference never
 * touches the wrong task. Open tasks are tried before completed ones.
 */
export function resolveTaskRef(tasks: readonly UserTask[], ref: string): UserTask | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const byId = tasks.find((t) => t.id === ref.trim());
  if (byId) return byId;
  for (const pool of [tasks.filter((t) => !t.completedAt), tasks.filter((t) => t.completedAt)]) {
    const exact = pool.filter((t) => t.title.toLowerCase() === needle);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return null;
    const partial = pool.filter((t) => t.title.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) return null;
  }
  return null;
}

/** Whether an open task's reminder has passed. */
export function taskIsOverdue(task: UserTask, now: Date): boolean {
  return !task.completedAt && !!task.remindAt && new Date(task.remindAt).getTime() <= now.getTime();
}

/** One task on a line: its title, state, reminder and id, for the model to read back. */
export function describeTask(task: UserTask, now: Date): string {
  const state = task.completedAt
    ? `done ${task.completedAt}`
    : task.remindAt
      ? `${taskIsOverdue(task, now) ? 'OVERDUE, was due' : 'due'} ${task.remindAt}`
      : 'open, no reminder';
  return `${task.title} — ${state} (id ${task.id})`;
}

/** The lines `list_tasks` prints: open tasks first (overdue flagged), then, if asked, the completed ones. */
export function formatTaskList(tasks: readonly UserTask[], now: Date, includeCompleted: boolean): string {
  const open = tasks.filter((t) => !t.completedAt);
  const done = tasks.filter((t) => t.completedAt);
  const overdue = open.filter((t) => taskIsOverdue(t, now)).length;
  const lines = [`Now: ${now.toISOString()}.`];
  if (open.length === 0) lines.push('No open tasks.');
  else {
    lines.push(`Open tasks (${open.length}${overdue ? `, ${overdue} overdue` : ''}):`);
    for (const t of open) lines.push(`- ${describeTask(t, now)}`);
  }
  if (includeCompleted) {
    if (done.length === 0) lines.push('No completed tasks on record.');
    else {
      lines.push(`Completed (${done.length}, most recent first):`);
      for (const t of done) lines.push(`- ${describeTask(t, now)}`);
    }
  } else if (done.length > 0) {
    lines.push(`(${done.length} completed task${done.length === 1 ? '' : 's'} not shown; pass include_completed to see them.)`);
  }
  return lines.join('\n');
}
