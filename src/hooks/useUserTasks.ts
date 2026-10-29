'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getWorkspaceSlugFromUrl } from '@/lib/api/client';
import { useAuth } from '@/hooks/useAuth';
import { useLiveRefetchInterval, useLiveTopic } from '@/components/live/LiveEventsProvider';
import { LIVE_TOPICS } from '@/lib/live/topics';
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
  type UserTask,
  type UserTaskUpdate,
} from '@/lib/api/tasks';

// Not the live topic's name on purpose: the stream names the owner in `ids`,
// and only that user's tabs refetch (below), not every member's.
const QUERY_ROOT = 'my-tasks';

/** While the live stream is down, how often the list re-reads itself. */
const FALLBACK_REFETCH_MS = 60_000;

/** Whether an open task's reminder time has passed. */
export function isTaskOverdue(task: UserTask, now: number = Date.now()): boolean {
  if (task.completedAt || !task.remindAt) return false;
  return new Date(task.remindAt).getTime() <= now;
}

/**
 * Open tasks keep the order they were added in; completed tasks follow,
 * most recently completed first — the same order the API returns.
 */
function sortTasks(tasks: UserTask[]): UserTask[] {
  const open = tasks
    .filter((t) => !t.completedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const done = tasks
    .filter((t) => t.completedAt)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  return [...open, ...done];
}

/**
 * The signed-in user's personal to-do list, shared through the react-query
 * cache so the Profile list, the sidebar tasks button and the reminder alerts
 * all read one request and see each other's edits immediately.
 *
 * Every mutation is optimistic — a checkbox should tick the instant it is
 * clicked — and rolls back with a toast if the server refuses it.
 */
export function useUserTasks() {
  const queryClient = useQueryClient();
  // Read the slug every render (not memoized once) so switching workspace in
  // the same shell moves to that workspace's cache entry.
  const slug = getWorkspaceSlugFromUrl();
  const key = useMemo(() => [QUERY_ROOT, slug], [slug]);
  const userId = useAuth().user?.id ?? null;

  const refetchInterval = useLiveRefetchInterval(FALLBACK_REFETCH_MS);
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: listTasks,
    staleTime: 30_000,
    refetchInterval,
  });

  // Another tab (or device) of this user changed a task: re-read the list.
  useLiveTopic(LIVE_TOPICS.userTasks, (ids) => {
    if (ids && userId && !ids.includes(userId)) return;
    void queryClient.invalidateQueries({ queryKey: key });
  });

  // Re-render on a clock so a reminder turns red (and alerts fire) the moment
  // it passes, not on the next refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const setTasks = useCallback(
    (fn: (prev: UserTask[]) => UserTask[]) => {
      queryClient.setQueryData<UserTask[]>(key, (prev) => sortTasks(fn(prev ?? [])));
    },
    [queryClient, key],
  );

  /** Snapshot, apply, and on failure restore + toast. */
  const optimistic = useCallback(
    async <T,>(apply: (prev: UserTask[]) => UserTask[], run: () => Promise<T>, failure: string) => {
      await queryClient.cancelQueries({ queryKey: key });
      const snapshot = queryClient.getQueryData<UserTask[]>(key);
      setTasks(apply);
      try {
        return await run();
      } catch (err) {
        queryClient.setQueryData(key, snapshot);
        toast.error(err instanceof Error && err.message ? err.message : failure);
        return undefined;
      }
    },
    [queryClient, key, setTasks],
  );

  const addTask = useCallback(
    async (title: string, remindAt: string | null) => {
      const tempId = `temp-${Date.now()}`;
      const temp: UserTask = {
        id: tempId,
        title,
        remindAt,
        completedAt: null,
        createdAt: new Date().toISOString(),
      };
      const created = await optimistic(
        (prev) => [...prev, temp],
        () => createTask({ title, remindAt }),
        'Could not add task',
      );
      if (created) setTasks((prev) => prev.map((t) => (t.id === tempId ? created : t)));
    },
    [optimistic, setTasks],
  );

  const editTask = useCallback(
    async (id: string, update: UserTaskUpdate) => {
      const updated = await optimistic(
        (prev) =>
          prev.map((t) => {
            if (t.id !== id) return t;
            return {
              ...t,
              ...(update.title !== undefined ? { title: update.title } : {}),
              ...(update.remindAt !== undefined ? { remindAt: update.remindAt } : {}),
              ...(update.completed !== undefined
                ? { completedAt: update.completed ? new Date().toISOString() : null }
                : {}),
            };
          }),
        () => updateTask(id, update),
        'Could not update task',
      );
      if (updated) setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    },
    [optimistic, setTasks],
  );

  const removeTask = useCallback(
    async (id: string) => {
      await optimistic(
        (prev) => prev.filter((t) => t.id !== id),
        () => deleteTask(id),
        'Could not delete task',
      );
    },
    [optimistic],
  );

  return {
    tasks: data ?? [],
    now,
    loading: isLoading,
    error: isError,
    addTask,
    editTask,
    removeTask,
  };
}
