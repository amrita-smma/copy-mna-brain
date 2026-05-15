'use client';

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  MessagesSquare,
  RefreshCw,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

import { RailGroup, RailItem } from './rail';
import { TaskCanvas } from './TaskCanvas';
import { RoutineCanvas } from './RoutineCanvas';
import { NewRoutineModal } from './NewRoutineModal';

import { routineRuns, routines } from './data';
import { DEFAULT_SELECTION, avatarToneClass } from './shared';
import type { AvatarTone, QueueTask, Selection } from './shared';

const QUEUE_PAGE_SIZE = 5;

type WorkforceQueueStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_human_input'
  | 'waiting_for_subagent'
  | 'resume_ready'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'timed_out';

type WorkforceTriggerSource = 'chat' | 'cron' | 'webhook' | 'api';

interface ApiQueueItem {
  id: string;
  agent_name: string;
  trigger_source: WorkforceTriggerSource;
  status: WorkforceQueueStatus;
  priority: number;
  input: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

const TRIGGER_ICONS: Record<WorkforceTriggerSource, typeof MessagesSquare> = {
  chat: MessagesSquare,
  cron: RefreshCw,
  webhook: Zap,
  api: Zap,
};

const TONE_PALETTE: AvatarTone[] = ['amber', 'indigo', 'aqua', 'rose', 'slate', 'violet'];

const IN_PROGRESS_STATUSES: WorkforceQueueStatus[] = [
  'running',
  'waiting_for_human_input',
  'waiting_for_subagent',
  'resume_ready',
];
const DONE_STATUSES: WorkforceQueueStatus[] = [
  'succeeded',
  'failed',
  'rejected',
  'timed_out',
];

function toneForId(id: string): AvatarTone {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TONE_PALETTE[h % TONE_PALETTE.length];
}

function titleOf(item: ApiQueueItem): string {
  const t = (item.input as { title?: unknown })?.title;
  if (typeof t === 'string' && t.trim()) return t;
  const inst = (item.input as { instruction?: unknown })?.instruction;
  if (typeof inst === 'string' && inst.trim()) return inst.slice(0, 60);
  return item.agent_name;
}

function initialsOf(agent: string): string {
  const parts = agent.split(/[_\s-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return agent.slice(0, 2).toUpperCase();
}

function toQueueTask(item: ApiQueueItem): QueueTask {
  return {
    id: item.id,
    title: titleOf(item),
    owner: item.agent_name,
    initials: initialsOf(item.agent_name),
    avatarTone: toneForId(item.id),
    icon: TRIGGER_ICONS[item.trigger_source] ?? Zap,
  };
}

interface WorkforceTasksProps {
  initialTaskId?: string | null;
}

export function WorkforceTasks({ initialTaskId = null }: WorkforceTasksProps = {}) {
  const [selection, setSelection] = useState<Selection>(
    initialTaskId ? { kind: 'task', id: initialTaskId } : DEFAULT_SELECTION,
  );
  const [items, setItems] = useState<ApiQueueItem[]>([]);
  // Local-only drag reordering of pending tasks. Not persisted yet — the
  // backend has no priority-update endpoint. New items append to the tail.
  const [queueOrder, setQueueOrder] = useState<string[]>([]);
  const [queuePage, setQueuePage] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [routineModalOpen, setRoutineModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/workforce-queue');
      if (!res.ok) throw new Error(`Failed to load queue (HTTP ${res.status})`);
      const data = (await res.json()) as { items?: ApiQueueItem[] };
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchQueue();
  }, [fetchQueue]);

  const inProgressItems = useMemo(
    () => items.filter((i) => IN_PROGRESS_STATUSES.includes(i.status)).map(toQueueTask),
    [items],
  );

  const pendingItems = useMemo(() => {
    const tasks = items.filter((i) => i.status === 'pending').map(toQueueTask);
    if (queueOrder.length === 0) return tasks;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ordered: QueueTask[] = [];
    for (const id of queueOrder) {
      const t = byId.get(id);
      if (t) {
        ordered.push(t);
        byId.delete(id);
      }
    }
    for (const t of byId.values()) ordered.push(t);
    return ordered;
  }, [items, queueOrder]);

  const doneItems = useMemo(
    () => items.filter((i) => DONE_STATUSES.includes(i.status)).map(toQueueTask),
    [items],
  );

  const totalQueuePages = Math.max(1, Math.ceil(pendingItems.length / QUEUE_PAGE_SIZE));
  const paginatedQueue = useMemo(
    () =>
      pendingItems.slice(queuePage * QUEUE_PAGE_SIZE, (queuePage + 1) * QUEUE_PAGE_SIZE),
    [pendingItems, queuePage],
  );

  const selectedRoutine =
    selection.kind === 'routine'
      ? routines.find((r) => r.id === selection.id)
      : undefined;
  const showTaskCanvas = !selectedRoutine;

  const goToTask = (id: string) => setSelection({ kind: 'task', id });
  const goToRoutine = (id: string) => setSelection({ kind: 'routine', id });

  const selectedTaskId =
    selection.kind === 'task' && selection.id !== 'active' ? selection.id : null;

  // Keep the URL in sync with task selection: `/ai-workforce/tasks/<uuid>`
  // when a specific task is selected, `/ai-workforce` otherwise (routine
  // selection and the synthetic 'active' default).
  //
  // Use window.history.replaceState (not router.replace) — this updates the
  // URL bar without triggering a Next.js soft navigation, so the server
  // component doesn't re-run and the page doesn't flicker between task
  // switches. The URL here is a deep-link/bookmark affordance, not a server
  // input — all the data is already in client state. Back/forward buttons
  // still work because the browser dispatches popstate events that Next
  // intercepts for the actual route change.
  const urlReconciled = useRef(false);
  useEffect(() => {
    if (!urlReconciled.current) {
      urlReconciled.current = true;
      return;
    }
    const target = selectedTaskId
      ? `/ai-workforce/tasks/${selectedTaskId}`
      : '/ai-workforce';
    if (typeof window !== 'undefined' && window.location.pathname !== target) {
      window.history.replaceState(null, '', target);
    }
  }, [selectedTaskId]);

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const handleDragOver = (e: React.DragEvent, overId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggingId || draggingId === overId) return;
    setQueueOrder((prev) => {
      const base = prev.length ? prev : pendingItems.map((t) => t.id);
      const fromIdx = base.indexOf(draggingId);
      const toIdx = base.indexOf(overId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return base;
      const next = [...base];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };
  const handleDragEnd = () => setDraggingId(null);

  return (
    <div className="flex-1 grid grid-cols-[280px_1fr] min-h-0 overflow-hidden bg-muted/20">
      <aside className="border-r bg-muted/30 flex flex-col min-h-0">
        <div className="flex-shrink-0 p-3 border-b">
          <button
            type="button"
            onClick={() => setRoutineModalOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            New Routine
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          <RailGroup label="Routines" count={routines.length}>
            <div className="space-y-0.5">
              {routines.map((routine) => {
                const Icon = routine.icon;
                const isActive =
                  selection.kind === 'routine' && selection.id === routine.id;
                return (
                  <RailItem
                    key={routine.id}
                    onClick={() => goToRoutine(routine.id)}
                    active={isActive}
                    icon={<Icon className="h-3 w-3" />}
                    iconClass={
                      routine.isFiring
                        ? 'bg-amber-50 text-amber-600'
                        : 'bg-emerald-50 text-emerald-700'
                    }
                    title={routine.name}
                    meta={
                      <span className="flex items-center gap-1">
                        {routine.isFiring && (
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                        )}
                        {routine.scheduleSummary}
                      </span>
                    }
                  />
                );
              })}
            </div>
          </RailGroup>

          {inProgressItems.length > 0 && (
            <RailGroup label="In progress" count={inProgressItems.length}>
              <div className="space-y-0.5">
                {inProgressItems.map((task) => {
                  const Icon = task.icon;
                  return (
                    <RailItem
                      key={task.id}
                      onClick={() => goToTask(task.id)}
                      active={showTaskCanvas && selectedTaskId === task.id}
                      icon={<Icon className="h-3 w-3" />}
                      iconClass="bg-violet-100 text-violet-600"
                      title={task.title}
                      meta={
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'h-3 w-3 rounded-full grid place-items-center text-[7px] font-bold',
                              avatarToneClass[task.avatarTone],
                            )}
                          >
                            {task.initials}
                          </span>
                          {task.owner}
                        </span>
                      }
                    />
                  );
                })}
              </div>
            </RailGroup>
          )}

          <RailGroup
            label="Queued"
            count={pendingItems.length}
            hint={pendingItems.length > 1 ? 'drag to reorder' : undefined}
          >
            {loading ? (
              <div className="px-2 py-2 text-[11px] text-muted-foreground/70">
                Loading…
              </div>
            ) : error ? (
              <div className="px-2 py-2 text-[11px] text-rose-600">{error}</div>
            ) : pendingItems.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-muted-foreground/70">
                Nothing queued right now.
              </div>
            ) : (
              <>
                <div className="space-y-0.5">
                  {paginatedQueue.map((task) => {
                    const Icon = task.icon;
                    const position = pendingItems.findIndex((t) => t.id === task.id) + 1;
                    return (
                      <RailItem
                        key={task.id}
                        onClick={() => goToTask(task.id)}
                        active={showTaskCanvas && selectedTaskId === task.id}
                        showDragHandle
                        draggable
                        isDragging={draggingId === task.id}
                        onDragStart={(e) => handleDragStart(e, task.id)}
                        onDragOver={(e) => handleDragOver(e, task.id)}
                        onDragEnd={handleDragEnd}
                        onDrop={(e) => e.preventDefault()}
                        icon={<Icon className="h-3 w-3" />}
                        iconClass="bg-violet-50 text-violet-700"
                        title={
                          <>
                            <span className="font-mono text-[10px] text-muted-foreground/70 mr-1.5">
                              #{position}
                            </span>
                            {task.title}
                          </>
                        }
                        meta={
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                'h-3 w-3 rounded-full grid place-items-center text-[7px] font-bold',
                                avatarToneClass[task.avatarTone],
                              )}
                            >
                              {task.initials}
                            </span>
                            {task.owner}
                          </span>
                        }
                      />
                    );
                  })}
                </div>
                {totalQueuePages > 1 && (
                  <div className="flex items-center justify-between px-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setQueuePage((p) => Math.max(0, p - 1))}
                      disabled={queuePage === 0}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Prev
                    </button>
                    <span className="text-[11px] text-muted-foreground/70">
                      Page {queuePage + 1} of {totalQueuePages}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setQueuePage((p) => Math.min(totalQueuePages - 1, p + 1))
                      }
                      disabled={queuePage >= totalQueuePages - 1}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground disabled:cursor-not-allowed"
                    >
                      Next
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </>
            )}
          </RailGroup>

          {doneItems.length > 0 && (
            <RailGroup label="Done" count={doneItems.length}>
              <div className="space-y-0.5">
                {doneItems.map((task) => (
                  <RailItem
                    key={task.id}
                    onClick={() => goToTask(task.id)}
                    active={showTaskCanvas && selectedTaskId === task.id}
                    icon={<Check className="h-3 w-3" strokeWidth={3} />}
                    iconClass="bg-emerald-50 text-emerald-600"
                    title={task.title}
                    meta={
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'h-3 w-3 rounded-full grid place-items-center text-[7px] font-bold',
                            avatarToneClass[task.avatarTone],
                          )}
                        >
                          {task.initials}
                        </span>
                        {task.owner}
                      </span>
                    }
                  />
                ))}
              </div>
            </RailGroup>
          )}
        </div>
      </aside>

      {selectedRoutine ? (
        <RoutineCanvas
          routine={selectedRoutine}
          runs={routineRuns[selectedRoutine.id] ?? []}
        />
      ) : (
        <TaskCanvas taskId={selectedTaskId} />
      )}

      <NewRoutineModal open={routineModalOpen} onOpenChange={setRoutineModalOpen} />
    </div>
  );
}
