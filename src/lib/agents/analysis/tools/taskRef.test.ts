import { describe, expect, it } from 'vitest';
import { describeTask, formatTaskList, resolveTaskRef, taskIsOverdue } from './taskRef';
import type { UserTask } from '@/lib/services/userTaskService';

const task = (over: Partial<UserTask> & { id: string; title: string }): UserTask => ({
  remindAt: null,
  completedAt: null,
  createdAt: '2026-10-20T08:00:00.000Z',
  ...over,
});

const now = new Date('2026-10-21T10:00:00.000Z');
const tasks = [
  task({ id: 't1', title: 'Call Budi' }),
  task({ id: 't2', title: 'Send the teaser to Ana', remindAt: '2026-10-21T09:00:00.000Z' }),
  task({ id: 't3', title: 'Call Budi about the SPA', remindAt: '2026-10-22T09:00:00.000Z' }),
  task({ id: 't4', title: 'Book the room', completedAt: '2026-10-20T12:00:00.000Z' }),
];

describe('resolveTaskRef', () => {
  it('finds a task by id, by exact title, or by a unique phrase, open tasks first', () => {
    expect(resolveTaskRef(tasks, 't4')?.id).toBe('t4');
    expect(resolveTaskRef(tasks, 'call budi')?.id).toBe('t1');
    expect(resolveTaskRef(tasks, 'teaser')?.id).toBe('t2');
    expect(resolveTaskRef(tasks, 'room')?.id).toBe('t4');
  });

  it('returns null for an ambiguous phrase, a blank, or nothing matching', () => {
    expect(resolveTaskRef(tasks, 'call')).toBeNull();
    expect(resolveTaskRef(tasks, '  ')).toBeNull();
    expect(resolveTaskRef(tasks, 'nothing like this')).toBeNull();
  });
});

describe('taskIsOverdue / describeTask', () => {
  it('flags an open task whose reminder passed, and never a completed one', () => {
    expect(taskIsOverdue(tasks[1]!, now)).toBe(true);
    expect(taskIsOverdue(tasks[2]!, now)).toBe(false);
    expect(taskIsOverdue(task({ id: 'x', title: 'x', remindAt: '2026-10-21T09:00:00.000Z', completedAt: '2026-10-21T09:30:00.000Z' }), now)).toBe(false);
    expect(describeTask(tasks[1]!, now)).toBe('Send the teaser to Ana — OVERDUE, was due 2026-10-21T09:00:00.000Z (id t2)');
    expect(describeTask(tasks[0]!, now)).toBe('Call Budi — open, no reminder (id t1)');
    expect(describeTask(tasks[3]!, now)).toBe('Book the room — done 2026-10-20T12:00:00.000Z (id t4)');
  });
});

describe('formatTaskList', () => {
  it('prints the time, the open tasks with an overdue count, and a note about hidden completed ones', () => {
    const out = formatTaskList(tasks, now, false);
    expect(out).toContain('Now: 2026-10-21T10:00:00.000Z.');
    expect(out).toContain('Open tasks (3, 1 overdue):');
    expect(out).toContain('- Call Budi — open, no reminder (id t1)');
    expect(out).toContain('(1 completed task not shown; pass include_completed to see them.)');
    expect(out).not.toContain('Book the room');
  });

  it('lists the completed tasks when asked, and says when there are none', () => {
    expect(formatTaskList(tasks, now, true)).toContain('Completed (1, most recent first):\n- Book the room');
    expect(formatTaskList([], now, true)).toContain('No open tasks.\nNo completed tasks on record.');
  });
});
