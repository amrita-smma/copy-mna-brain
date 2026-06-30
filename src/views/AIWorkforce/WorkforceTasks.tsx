'use client';

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  MessagesSquare,
  RefreshCw,
  Search,
  X,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

import { RailGroup, RailItem } from './rail';
import { TaskCanvas } from './TaskCanvas';
import { RoutineCanvas } from './RoutineCanvas';
import { NewRoutineModal } from './NewRoutineModal';

import { DEFAULT_SELECTION, avatarToneClass } from './shared';
import type { AvatarTone, QueueTask, Selection } from './shared';
import { apiRoutineToUi } from './routineApi';
import type { ApiRoutine } from './routineApi';

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
  origin_routine_id: string | null;
  triggered_by_user_id: string | null;
  triggered_by_user_name: string | null;
  // Needed to tell user-cancelled rows apart from genuine failures —
  // both share status='failed' at the DB level.
  error?: Record<string, unknown> | null;
}

// Categorises a terminal queue row for sidebar rendering. `succeeded` →
// green check; user-cancelled `failed` → grey ban; anything else terminal
// → rose X. Returns null for non-terminal statuses.
type TerminalKind = 'success' | 'cancelled' | 'failed';
function terminalKindOf(item: ApiQueueItem): TerminalKind | null {
  if (item.status === 'succeeded') return 'success';
  if (item.status === 'failed') {
    const code = (item.error as { code?: unknown } | null)?.code;
    return code === 'cancelled_by_user' ? 'cancelled' : 'failed';
  }
  if (item.status === 'rejected' || item.status === 'timed_out') return 'failed';
  return null;
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
  'waiting_for_subagent',
  'resume_ready',
];
const NEEDS_ACTION_STATUSES: WorkforceQueueStatus[] = [
  'waiting_for_human_input',
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

function initialsOf(label: string): string {
  const parts = label.split(/[_\s-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

// Inline meta attribution for routine-spawned rows. Replaces the (always
// "analysis") agent_name line with a compact, clickable routine reference.
// Lowercase + muted styling so it sits next to "Started 14:33" without
// dominating the card; the parent row's click still navigates to the task,
// this chip's click jumps to the routine.
function RoutineChip({
  name,
  onClick,
}: {
  name: string;
  onClick: () => void;
}) {
  // Rendered as <span role="button"> rather than <button> because this chip
  // appears inside RailItem's outer <button>, and HTML doesn't allow nested
  // buttons (Next.js flags it as a hydration error). stopPropagation keeps
  // the row's click handler from firing when the chip is clicked.
  return (
    <span
      role="button"
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex items-center gap-1 min-w-0 text-[11px] text-emerald-700 hover:underline cursor-pointer"
      title={`Routine: ${name}`}
    >
      <RefreshCw className="h-2.5 w-2.5 flex-shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

// Owner attribution = "who kicked this off." Prefer the submitter's name
// (joined in by the API from users.name); fall back to a per-trigger-source
// label so cron/webhook/api rows don't render an empty avatar.
function ownerOf(item: ApiQueueItem): string {
  if (item.triggered_by_user_name) return item.triggered_by_user_name;
  switch (item.trigger_source) {
    case 'cron':
      return 'Cron';
    case 'webhook':
      return 'Webhook';
    case 'api':
      return 'API';
    case 'chat':
    default:
      return item.agent_name;
  }
}

// Compact "8m" / "2h" / "3d" style for the card's footer. Returns "now"
// for anything under a minute and degrades gracefully on bad input.
function relTime(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const deltaSec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (deltaSec < 60) return 'now';
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function toQueueTask(
  item: ApiQueueItem,
  routineNameById: Map<string, string>,
  basis: 'created_at' | 'started_at' | 'ended_at' = 'created_at',
): QueueTask {
  const routineId = item.origin_routine_id ?? undefined;
  // If origin_routine_id is set but the routine row isn't in our map (most
  // likely archived), fall back to a generic 'Routine' label rather than
  // hiding the attribution entirely.
  const routineName = routineId
    ? routineNameById.get(routineId) ?? 'Routine'
    : undefined;
  const owner = ownerOf(item);
  // Fall back to created_at when the requested basis isn't populated yet
  // (e.g. running item with no started_at, done item where ended_at is null).
  const tsCandidate =
    basis === 'started_at'
      ? item.started_at ?? item.created_at
      : basis === 'ended_at'
        ? item.ended_at ?? item.created_at
        : item.created_at;
  return {
    id: item.id,
    title: titleOf(item),
    owner,
    initials: initialsOf(owner),
    avatarTone: toneForId(item.id),
    icon: TRIGGER_ICONS[item.trigger_source] ?? Zap,
    routineId,
    routineName,
    relTime: relTime(tsCandidate),
  };
}

// Start of the user's local day. Used to filter "Done today" so historical
// completions don't dilute the day's accomplishment count.
function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface WorkforceTasksProps {
  initialTaskId?: string | null;
}

export function WorkforceTasks({ initialTaskId = null }: WorkforceTasksProps = {}) {
  const [selection, setSelection] = useState<Selection>(
    initialTaskId ? { kind: 'task', id: initialTaskId } : DEFAULT_SELECTION,
  );
  const [items, setItems] = useState<ApiQueueItem[]>([]);
  const [apiRoutines, setApiRoutines] = useState<ApiRoutine[]>([]);
  // Local-only drag reordering of pending tasks. Not persisted yet — the
  // backend has no priority-update endpoint. New items append to the tail.
  const [queueOrder, setQueueOrder] = useState<string[]>([]);
  const [queuePage, setQueuePage] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [routineModalOpen, setRoutineModalOpen] = useState(false);
  // When set, the routine modal opens in EDIT mode prefilled with this row.
  // Cleared on close so the next "New Routine" click gets a blank form.
  const [editingRoutine, setEditingRoutine] = useState<ApiRoutine | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [doneTodaySearch, setDoneTodaySearch] = useState('');

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

  const fetchRoutines = useCallback(async () => {
    try {
      const res = await fetch('/api/routines');
      if (!res.ok) throw new Error(`Failed to load routines (HTTP ${res.status})`);
      const data = (await res.json()) as { items?: ApiRoutine[] };
      setApiRoutines(data.items ?? []);
    } catch (e) {
      // Don't surface routine load failures in the error banner — the queue
      // still works without them. Log so it's visible during dev.
      console.error('[WorkforceTasks] fetchRoutines failed:', e);
    }
  }, []);

  useEffect(() => {
    void fetchQueue();
    void fetchRoutines();
  }, [fetchQueue, fetchRoutines]);

  // Poll the queue + routines while the tab is foregrounded. Without this,
  // a routine that fires at 15:12 only shows up after a manual page reload;
  // 5s is short enough that new runs appear "instantly" to the user and
  // long enough that an idle dashboard stays cheap. We gate on
  // `document.visibilityState` so a backgrounded tab doesn't keep pinging
  // — Page Visibility API fires `visibilitychange` when the user returns,
  // which the effect picks up via re-render of the interval below if we
  // ever wire it; for now a simple skip is good enough.
  useEffect(() => {
    const POLL_MS = 5000;
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void fetchQueue();
      void fetchRoutines();
    };
    const intervalId = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [fetchQueue, fetchRoutines]);

  const runCountByRoutine = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items) {
      if (!i.origin_routine_id) continue;
      counts.set(i.origin_routine_id, (counts.get(i.origin_routine_id) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  // Routine-name lookup used by sidebar rows to attribute each
  // routine-spawned queue item back to its source routine.
  const routineNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of apiRoutines) map.set(r.id, r.title);
    return map;
  }, [apiRoutines]);

  const routines = useMemo(
    () =>
      apiRoutines.map((row) =>
        apiRoutineToUi(row, { runCount: runCountByRoutine.get(row.id) ?? 0 }),
      ),
    [apiRoutines, runCountByRoutine],
  );

  const handleDeleteRoutine = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/routines/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        console.error('[WorkforceTasks] delete routine failed', res.status);
        return;
      }
      // After archive, refetch and reset the selection if we just deleted
      // the active routine.
      setSelection((prev) =>
        prev.kind === 'routine' && prev.id === id ? DEFAULT_SELECTION : prev,
      );
      await fetchRoutines();
    },
    [fetchRoutines],
  );

  // Poll the queue every 10s so users see status changes (HITL pauses,
  // completions, the next claim) without manually refreshing. Pauses when
  // the tab is backgrounded and while a drag is in progress, and fires an
  // immediate catch-up fetch when the tab becomes visible again. Read
  // `draggingId` through a ref so we don't tear down and rebuild the
  // interval every time the drag state changes.
  const draggingIdRef = useRef(draggingId);
  useEffect(() => {
    draggingIdRef.current = draggingId;
  }, [draggingId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const POLL_INTERVAL_MS = 10_000;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        if (
          document.visibilityState === 'visible' &&
          draggingIdRef.current === null
        ) {
          void fetchQueue();
        }
      }, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchQueue();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchQueue]);

  const inProgressItems = useMemo(
    () =>
      items
        .filter((i) => IN_PROGRESS_STATUSES.includes(i.status))
        .map((i) => toQueueTask(i, routineNameById, 'started_at')),
    [items, routineNameById],
  );

  const needsActionItems = useMemo(
    () =>
      items
        .filter((i) => NEEDS_ACTION_STATUSES.includes(i.status))
        .map((i) => toQueueTask(i, routineNameById, 'started_at')),
    [items, routineNameById],
  );

  const pendingItems = useMemo(() => {
    // Sort by priority DESC then created_at ASC — mirrors the dispatcher's
    // claim ORDER BY so the visual order matches the run order across
    // tabs / reloads (where queueOrder isn't populated yet).
    const sorted = items
      .filter((i) => i.status === 'pending')
      .slice()
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return Date.parse(a.created_at) - Date.parse(b.created_at);
      });
    const tasks = sorted.map((i) => toQueueTask(i, routineNameById, 'created_at'));
    if (queueOrder.length === 0) return tasks;
    // In-flight drag: queueOrder is the source of truth for the visual
    // order until the POST settles and we clear it.
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
  }, [items, queueOrder, routineNameById]);

  // "Done today" — only terminal rows whose ended_at falls in the current
  // local day. Rows missing ended_at (rare) fall back to created_at so a
  // freshly-completed row never disappears just because the timestamp
  // didn't write yet.
  //
  // Carries `kind` alongside each task so the sidebar can pick the right
  // icon (green check / grey ban / rose X) instead of using one emerald
  // check for everything — see the doneTodayItems render block below.
  const doneTodayItems = useMemo(() => {
    const cutoff = startOfTodayMs();
    return items
      .filter((i) => {
        if (!DONE_STATUSES.includes(i.status)) return false;
        const ts = Date.parse(i.ended_at ?? i.created_at);
        return !Number.isNaN(ts) && ts >= cutoff;
      })
      .map((i) => ({
        task: toQueueTask(i, routineNameById, 'ended_at'),
        kind: terminalKindOf(i) ?? 'failed',
      }));
  }, [items, routineNameById]);

  const filteredDoneTodayItems = useMemo(() => {
    const q = doneTodaySearch.trim().toLowerCase();
    if (!q) return doneTodayItems;
    return doneTodayItems.filter(({ task }) =>
      task.title.toLowerCase().includes(q),
    );
  }, [doneTodayItems, doneTodaySearch]);

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
  const handleDragEnd = async () => {
    const order = queueOrder;
    setDraggingId(null);
    if (order.length === 0) return;

    // Server-side: top of the queue gets highest priority. Leave 0 reserved
    // for freshly enqueued rows so they always land at the bottom (the
    // dispatcher's ORDER BY uses priority DESC, created_at ASC).
    const payload = order.map((id, idx) => ({
      id,
      priority: order.length - idx,
    }));

    try {
      const res = await fetch('/api/workforce-queue/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: payload }),
      });
      if (!res.ok) {
        throw new Error(`Reorder failed (HTTP ${res.status})`);
      }
      // Refetch to pick up the new priorities, then clear the local override
      // so subsequent renders use the server-derived sort.
      await fetchQueue();
      setQueueOrder([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder queue');
      // Revert: clear local override and refetch so the UI snaps back to
      // the server's order rather than a half-applied state.
      setQueueOrder([]);
      void fetchQueue();
    }
  };

  return (
    <div data-testid="workforce-tasks" className="flex-1 grid grid-cols-[280px_1fr] min-h-0 overflow-hidden bg-muted/20">
      <aside data-testid="workforce-sidebar" className="border-r bg-muted/30 flex flex-col min-h-0">
        <div className="flex-shrink-0 p-3 border-b">
          <button
            type="button"
            data-testid="workforce-new-routine-button"
            onClick={() => setRoutineModalOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            New Routine
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          <RailGroup data-testid="workforce-routines-group" label="Routines" count={routines.length}>
            <div className="space-y-0.5">
              {routines.map((routine) => {
                const Icon = routine.icon;
                const isActive =
                  selection.kind === 'routine' && selection.id === routine.id;
                return (
                  <RailItem
                    key={routine.id}
                    data-testid={`workforce-routine-item-${routine.id}`}
                    onClick={() => goToRoutine(routine.id)}
                    active={isActive}
                    icon={<Icon className="h-3 w-3" />}
                    iconClass={
                      routine.isFiring
                        ? 'bg-amber-50 text-amber-600'
                        : 'bg-emerald-50 text-emerald-700'
                    }
                    title={routine.name}
                    tooltipText={routine.name}
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

          {needsActionItems.length > 0 && (
            <RailGroup data-testid="workforce-needs-action-group" label="Need action" count={needsActionItems.length}>
              <div className="space-y-0.5">
                {needsActionItems.map((task) => (
                  <RailItem
                    key={task.id}
                    data-testid={`workforce-needs-action-item-${task.id}`}
                    onClick={() => goToTask(task.id)}
                    active={showTaskCanvas && selectedTaskId === task.id}
                    icon={<AlertCircle className="h-3 w-3" />}
                    iconClass="bg-amber-50 text-amber-600"
                    title={task.title}
                    tooltipText={task.title}
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
                        {task.relTime && (
                          <span className="text-muted-foreground/70">
                            · {task.relTime}
                          </span>
                        )}
                      </span>
                    }
                  />
                ))}
              </div>
            </RailGroup>
          )}

          {inProgressItems.length > 0 && (
            <RailGroup data-testid="workforce-in-progress-group" label="In progress" count={inProgressItems.length}>
              <div className="space-y-0.5">
                {inProgressItems.map((task) => {
                  const Icon = task.icon;
                  return (
                    <RailItem
                      key={task.id}
                      data-testid={`workforce-in-progress-item-${task.id}`}
                      onClick={() => goToTask(task.id)}
                      active={showTaskCanvas && selectedTaskId === task.id}
                      icon={<Icon className="h-3 w-3" />}
                      iconClass="bg-violet-100 text-violet-600"
                      title={task.title}
                      tooltipText={task.title}
                      meta={
                        <span className="flex items-center gap-1.5 min-w-0">
                          {task.routineName && task.routineId ? (
                            <RoutineChip
                              name={task.routineName}
                              onClick={() => goToRoutine(task.routineId!)}
                            />
                          ) : (
                            <>
                              <span
                                className={cn(
                                  'h-3 w-3 rounded-full grid place-items-center text-[7px] font-bold flex-shrink-0',
                                  avatarToneClass[task.avatarTone],
                                )}
                              >
                                {task.initials}
                              </span>
                              <span className="truncate">{task.owner}</span>
                            </>
                          )}
                          {task.relTime && (
                            <span className="text-muted-foreground/70 flex-shrink-0">
                              · {task.relTime}
                            </span>
                          )}
                        </span>
                      }
                    />
                  );
                })}
              </div>
            </RailGroup>
          )}

          <RailGroup
            data-testid="workforce-queued-group"
            label="Queued"
            count={pendingItems.length}
            hint={pendingItems.length > 1 ? 'drag to reorder' : undefined}
            collapsible
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
                        data-testid={`workforce-queued-item-${task.id}`}
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
                        tooltipText={`#${position} ${task.title}`}
                        meta={
                          <span className="flex items-center gap-1.5 min-w-0">
                            {task.routineName && task.routineId ? (
                              <RoutineChip
                                name={task.routineName}
                                onClick={() => goToRoutine(task.routineId!)}
                              />
                            ) : (
                              <>
                                <span
                                  className={cn(
                                    'h-3 w-3 rounded-full grid place-items-center text-[7px] font-bold flex-shrink-0',
                                    avatarToneClass[task.avatarTone],
                                  )}
                                >
                                  {task.initials}
                                </span>
                                <span className="truncate">{task.owner}</span>
                              </>
                            )}
                            {task.relTime && (
                              <span className="text-muted-foreground/70 flex-shrink-0">
                                · {task.relTime}
                              </span>
                            )}
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
                      data-testid="workforce-queue-prev-button"
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
                      data-testid="workforce-queue-next-button"
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

          {doneTodayItems.length > 0 && (
            <RailGroup
              data-testid="workforce-done-today-group"
              label="Done today"
              count={filteredDoneTodayItems.length}
              collapsible
            >
              <div className="relative mb-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  data-testid="workforce-done-today-search"
                  type="text"
                  value={doneTodaySearch}
                  onChange={(e) => setDoneTodaySearch(e.target.value)}
                  placeholder="Search tasks..."
                  className="h-8 pl-8 pr-7 text-[12px]"
                />
                {doneTodaySearch && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setDoneTodaySearch('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              {filteredDoneTodayItems.length === 0 ? (
                <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
                  No tasks found
                </div>
              ) : (
              <div className="space-y-0.5">
                {filteredDoneTodayItems.map(({ task, kind }) => {
                  // Per-outcome icon. Kept inline because this is the only
                  // place these mappings matter; lifting to a constant
                  // would buy nothing.
                  const Icon =
                    kind === 'success' ? Check : kind === 'cancelled' ? Ban : X;
                  const iconClass =
                    kind === 'success'
                      ? 'bg-emerald-50 text-emerald-600'
                      : kind === 'cancelled'
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-rose-50 text-rose-600';
                  return (
                  <RailItem
                    key={task.id}
                    data-testid={`workforce-done-today-item-${task.id}`}
                    onClick={() => goToTask(task.id)}
                    active={showTaskCanvas && selectedTaskId === task.id}
                    icon={<Icon className="h-3 w-3" strokeWidth={kind === 'success' ? 3 : 2.5} />}
                    iconClass={iconClass}
                    title={task.title}
                    tooltipText={task.title}
                    meta={
                      <span className="flex items-center gap-1.5 min-w-0">
                        {task.routineName && task.routineId ? (
                          <RoutineChip
                            name={task.routineName}
                            onClick={() => goToRoutine(task.routineId!)}
                          />
                        ) : (
                          <>
                            <span
                              className={cn(
                                'h-3 w-3 rounded-full grid place-items-center text-[7px] font-bold flex-shrink-0',
                                avatarToneClass[task.avatarTone],
                              )}
                            >
                              {task.initials}
                            </span>
                            <span className="truncate">{task.owner}</span>
                          </>
                        )}
                        {task.relTime && (
                          <span className="text-muted-foreground/70 flex-shrink-0">
                            · {task.relTime}
                          </span>
                        )}
                      </span>
                    }
                  />
                  );
                })}
              </div>
              )}
            </RailGroup>
          )}
        </div>
      </aside>

      {selectedRoutine ? (
        <RoutineCanvas
          routine={selectedRoutine}
          onDelete={() => handleDeleteRoutine(selectedRoutine.id)}
          onEnqueued={fetchQueue}
          onEdit={() => {
            const row = apiRoutines.find((r) => r.id === selectedRoutine.id);
            if (!row) return;
            setEditingRoutine(row);
            setRoutineModalOpen(true);
          }}
        />
      ) : (
        <TaskCanvas
          taskId={selectedTaskId}
          onRetried={(newId) => {
            // Jump to the freshly-enqueued retry row and pull the queue
            // straight away so the new row appears in "Queued" without
            // waiting for the next poll tick.
            goToTask(newId);
            void fetchQueue();
          }}
          onCancelled={() => {
            // Refetch so the cancelled row hops out of "In progress" /
            // "Queued" and into "Done today" on the sidebar immediately.
            void fetchQueue();
          }}
          onForked={(newId) => {
            // Same flow as onRetried — a follow-up run started from the
            // composer is a new queue row, so jump selection to it.
            goToTask(newId);
            void fetchQueue();
          }}
        />
      )}

      <NewRoutineModal
        open={routineModalOpen}
        onOpenChange={(next) => {
          setRoutineModalOpen(next);
          // Clear the edit target when the modal closes so a subsequent
          // "New Routine" click gets a blank form. We do this in the close
          // handler (rather than only after a successful save) so cancels
          // also reset the next open.
          if (!next) setEditingRoutine(null);
        }}
        onCreated={fetchRoutines}
        routine={editingRoutine ?? undefined}
      />
    </div>
  );
}
