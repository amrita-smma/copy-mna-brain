'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Inbox, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TraceLine, TraceProgressBar, type InterventionDecisionInput } from './trace';
import type { AvatarTone, TraceData } from './shared';
import { avatarToneClass } from './shared';

interface TraceActorResponse {
  id: string;
  name: string;
  initials: string;
  avatarTone: AvatarTone;
}

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

const IN_PROGRESS_STATUSES: WorkforceQueueStatus[] = [
  'pending',
  'running',
  'waiting_for_human_input',
  'waiting_for_subagent',
  'resume_ready',
];
// Statuses where Cancel is a meaningful action — anything not yet terminal.
const CANCELLABLE_STATUSES: WorkforceQueueStatus[] = [
  'pending',
  'running',
  'waiting_for_human_input',
  'waiting_for_subagent',
  'resume_ready',
];
// Statuses where Retry produces a fresh attempt. Matches the API's
// RETRYABLE_STATUSES guard in /retry/route.ts.
const RETRYABLE_STATUSES: WorkforceQueueStatus[] = [
  'failed',
  'rejected',
  'timed_out',
];
// Composer is disabled when the agent is actively burning compute. A user
// update written here could race a tool call mid-step. The /message API
// rejects these statuses with 409 as a server-side backstop.
const COMPOSER_THINKING_STATUSES: WorkforceQueueStatus[] = [
  'running',
  'waiting_for_subagent',
];
// Submitting a message on one of these attaches it to the row's
// pending_user_messages buffer; the agent drains the buffer on its next
// invoke/resume. No new row is created.
const COMPOSER_ATTACH_STATUSES: WorkforceQueueStatus[] = [
  'pending',
  'waiting_for_human_input',
  'resume_ready',
];

type ComposerMode = 'disabled' | 'attach' | 'fork';

function getComposerMode(status: WorkforceQueueStatus): ComposerMode {
  if (COMPOSER_THINKING_STATUSES.includes(status)) return 'disabled';
  if (COMPOSER_ATTACH_STATUSES.includes(status)) return 'attach';
  return 'fork';
}
const TRACE_POLL_MS = 2000;

interface ApiQueueItem {
  id: string;
  agent_name: string;
  trigger_source: 'chat' | 'cron' | 'webhook' | 'api';
  status: WorkforceQueueStatus;
  priority: number;
  input: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  // jsonb error payload. Read here to distinguish user-cancelled rows
  // (code='cancelled_by_user') from genuine agent failures — both share
  // status='failed' at the DB level (no separate enum for cancel).
  error?: Record<string, unknown> | null;
}

type StatusTone = { label: string; color: string; dot: string };
const STATUS_TONE: Record<WorkforceQueueStatus, StatusTone> = {
  pending: { label: 'Queued', color: 'text-amber-600', dot: 'bg-amber-500' },
  running: { label: 'Running', color: 'text-violet-600', dot: 'bg-violet-500 animate-pulse' },
  waiting_for_human_input: {
    label: 'Waiting on input',
    color: 'text-violet-600',
    dot: 'bg-violet-500 animate-pulse',
  },
  waiting_for_subagent: {
    label: 'Waiting on subagent',
    color: 'text-sky-600',
    dot: 'bg-sky-500 animate-pulse',
  },
  resume_ready: { label: 'Ready to resume', color: 'text-sky-600', dot: 'bg-sky-500' },
  succeeded: { label: 'Succeeded', color: 'text-emerald-600', dot: 'bg-emerald-500' },
  failed: { label: 'Failed', color: 'text-rose-600', dot: 'bg-rose-500' },
  rejected: { label: 'Rejected', color: 'text-rose-600', dot: 'bg-rose-500' },
  timed_out: { label: 'Timed out', color: 'text-rose-600', dot: 'bg-rose-500' },
};

// User-cancelled rows live under status='failed' (no separate enum value)
// but deserve a neutral label/color — they aren't agent failures and the
// red "Failed" pill misrepresents what happened.
const CANCELLED_TONE: StatusTone = {
  label: 'Cancelled',
  color: 'text-muted-foreground',
  dot: 'bg-muted-foreground/60',
};

function isCancelled(item: ApiQueueItem): boolean {
  return (
    item.status === 'failed' &&
    typeof item.error === 'object' &&
    item.error !== null &&
    (item.error as { code?: unknown }).code === 'cancelled_by_user'
  );
}

function fmtTs(ts: string | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function strField(input: Record<string, unknown>, key: string): string {
  const v = input?.[key];
  return typeof v === 'string' ? v : '';
}

interface TaskCanvasProps {
  taskId: string | null;
  // Called after a successful Retry with the id of the freshly-enqueued row,
  // so the parent can navigate selection / refetch the sidebar queue. When
  // unset, TaskCanvas falls back to showing a "Retried as #abc12345" line
  // without changing the route.
  onRetried?: (newId: string) => void;
  // Called after a successful Cancel, so the parent can refresh the sidebar
  // (the cancelled row will hop from "In progress" / "Queued" into the
  // terminal bucket on the next refetch).
  onCancelled?: (id: string) => void;
  // Called after submitting a chat message against a terminal task spawns a
  // fresh follow-up run. Same plumbing as onRetried: parent jumps selection
  // to the new row and refetches the sidebar.
  onForked?: (newId: string) => void;
}

export function TaskCanvas({
  taskId,
  onRetried,
  onCancelled,
  onForked,
}: TaskCanvasProps) {
  const [item, setItem] = useState<ApiQueueItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceSteps, setTraceSteps] = useState<TraceData[]>([]);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [canDecide, setCanDecide] = useState(false);
  const [actor, setActor] = useState<TraceActorResponse | null>(null);
  const [actionPending, setActionPending] = useState<'retry' | 'cancel' | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  const [composerSending, setComposerSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerToast, setComposerToast] = useState<string | null>(null);
  const traceLoadedRef = useRef(false);

  useEffect(() => {
    if (!taskId) {
      setItem(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/workforce-queue/${taskId}`);
        if (!res.ok) throw new Error(`Failed to load task (HTTP ${res.status})`);
        const data = (await res.json()) as { item?: ApiQueueItem };
        if (cancelled) return;
        setItem(data.item ?? null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load task');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Reset trace state when the selected task changes.
  useEffect(() => {
    setTraceSteps([]);
    setTraceError(null);
    setActor(null);
    setActionError(null);
    setActionPending(null);
    setComposerText('');
    setComposerError(null);
    setComposerToast(null);
    traceLoadedRef.current = false;
  }, [taskId]);

  // Fetch the task + trace on mount and poll while the task is non-terminal.
  // We refresh BOTH on each tick so the status pill, action buttons, and
  // ended_at line stay in sync with the row's true state — without this,
  // background transitions (agent finishes, reaper marks failed, another
  // user cancels) never propagate to the local item state and the UI shows
  // stale "Running" + Cancel button after the row is already terminal.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const [taskRes, traceRes] = await Promise.all([
          fetch(`/api/workforce-queue/${taskId}`),
          fetch(`/api/workforce-queue/${taskId}/trace`),
        ]);
        if (cancelled) return;
        if (taskRes.ok) {
          const data = (await taskRes.json()) as { item?: ApiQueueItem };
          if (data.item) setItem(data.item);
        }
        if (!traceRes.ok) {
          throw new Error(`Failed to load trace (HTTP ${traceRes.status})`);
        }
        const data = (await traceRes.json()) as {
          steps?: TraceData[];
          canDecide?: boolean;
          status?: WorkforceQueueStatus;
          actor?: TraceActorResponse;
        };
        if (cancelled) return;
        setTraceSteps(data.steps ?? []);
        setCanDecide(Boolean(data.canDecide));
        if (data.actor) setActor(data.actor);
        setTraceError(null);
        traceLoadedRef.current = true;
      } catch (e) {
        if (cancelled) return;
        setTraceError(e instanceof Error ? e.message : 'Failed to load trace');
      }
    };

    void refresh();
    const inProgress = item?.status && IN_PROGRESS_STATUSES.includes(item.status);
    if (!inProgress) return () => {
      cancelled = true;
    };
    const intervalId = window.setInterval(refresh, TRACE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [taskId, item?.status]);

  if (!taskId) {
    return (
      <main className="flex flex-col min-h-0 bg-card items-center justify-center text-muted-foreground">
        <Inbox className="h-10 w-10 mb-3 opacity-40" />
        <p className="text-sm">Select a task from the sidebar to see its progress.</p>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="flex flex-col min-h-0 bg-card items-center justify-center text-sm text-muted-foreground">
        Loading task…
      </main>
    );
  }

  if (error || !item) {
    return (
      <main className="flex flex-col min-h-0 bg-card items-center justify-center text-sm text-rose-600">
        {error ?? 'Task not found.'}
      </main>
    );
  }

  const title = strField(item.input, 'title') || item.agent_name;
  const instruction = strField(item.input, 'instruction');
  const tone = isCancelled(item) ? CANCELLED_TONE : STATUS_TONE[item.status];
  const canCancel = CANCELLABLE_STATUSES.includes(item.status);
  const canRetry = RETRYABLE_STATUSES.includes(item.status);
  const composerMode = getComposerMode(item.status);
  const composerDisabled = composerMode === 'disabled' || composerSending;
  const composerHint =
    composerMode === 'disabled'
      ? 'Replies are paused while the agent is working. They’ll re-open when it pauses or finishes.'
      : composerMode === 'attach'
        ? 'Your reply will be queued for this task and picked up on its next step.'
        : 'This task has finished. Your reply will start a follow-up run.';

  const handleCancel = async () => {
    if (!taskId || actionPending) return;
    setActionPending('cancel');
    setActionError(null);
    try {
      const res = await fetch(`/api/workforce-queue/${taskId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Cancel failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { item?: ApiQueueItem };
      if (data.item) setItem(data.item);
      onCancelled?.(taskId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to cancel task');
    } finally {
      setActionPending(null);
    }
  };

  const handleComposerSubmit = async () => {
    if (!taskId || composerDisabled) return;
    const text = composerText.trim();
    if (!text) return;
    setComposerSending(true);
    setComposerError(null);
    setComposerToast(null);
    try {
      const res = await fetch(`/api/workforce-queue/${taskId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = (await res.json().catch(() => null)) as
        | { data?: { kind: 'attached'; queue_position: number } | { kind: 'forked'; new_run_id: string }; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(body?.error ?? `Submit failed (HTTP ${res.status})`);
      }
      setComposerText('');
      const data = body?.data;
      if (data?.kind === 'attached') {
        const ord =
          data.queue_position === 1 ? 'next up' : `position ${data.queue_position}`;
        setComposerToast(`Queued for this task (${ord}).`);
      } else if (data?.kind === 'forked') {
        onForked?.(data.new_run_id);
      }
    } catch (e) {
      setComposerError(
        e instanceof Error ? e.message : 'Failed to send message',
      );
    } finally {
      setComposerSending(false);
    }
  };

  const handleRetry = async () => {
    if (!taskId || actionPending) return;
    setActionPending('retry');
    setActionError(null);
    try {
      const res = await fetch(`/api/workforce-queue/${taskId}/retry`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Retry failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { item?: ApiQueueItem };
      const newId = data.item?.id;
      if (newId && onRetried) {
        onRetried(newId);
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to retry task');
    } finally {
      setActionPending(null);
    }
  };

  return (
    <main className="flex flex-col min-h-0 bg-card">
      <div className="flex-1 overflow-y-auto px-9 py-6">
        {/* Task header */}
        <div className="space-y-2.5 mb-7">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="inline-flex items-center gap-2 text-[11px] font-bold tracking-wider uppercase">
              <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />
              <span className={tone.color}>{tone.label}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="text-muted-foreground font-mono">
                #{item.id.slice(0, 8)}
              </span>
            </div>
            {(canCancel || canRetry) && (
              <div className="inline-flex items-center gap-2">
                {canCancel && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={actionPending !== null}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 hover:border-rose-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <X className="h-3 w-3" strokeWidth={2.5} />
                    {actionPending === 'cancel' ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
                {canRetry && (
                  <button
                    type="button"
                    onClick={handleRetry}
                    disabled={actionPending !== null}
                    className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 hover:border-violet-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RotateCcw className="h-3 w-3" strokeWidth={2.5} />
                    {actionPending === 'retry' ? 'Retrying…' : 'Retry'}
                  </button>
                )}
              </div>
            )}
          </div>
          {actionError && (
            <div className="rounded-md border border-rose-200 bg-rose-50/60 px-2.5 py-1.5 text-[11px] text-rose-700">
              {actionError}
            </div>
          )}
          <h2 className="text-[22px] font-extrabold tracking-tight leading-tight">
            {title}
          </h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {actor && (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn(
                      'h-5 w-5 rounded-full grid place-items-center text-[9px] font-bold',
                      avatarToneClass[actor.avatarTone],
                    )}
                  >
                    {actor.initials}
                  </span>
                  <span className="text-foreground/80 font-medium">
                    {actor.name}
                  </span>
                </span>
                <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
              </>
            )}
            <span className="inline-flex items-center gap-1.5">
              Agent <span className="font-mono text-foreground/80">{item.agent_name}</span>
            </span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <span>Created {fmtTs(item.created_at)}</span>
            {item.started_at && (
              <>
                <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                <span>Started {fmtTs(item.started_at)}</span>
              </>
            )}
            {item.ended_at && (
              <>
                <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                <span>Ended {fmtTs(item.ended_at)}</span>
              </>
            )}
            {item.trigger_source === 'chat' && (
              <>
                <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                <span className="inline-flex items-center gap-1 text-violet-600 font-semibold">
                  <Sparkles className="h-3 w-3" />
                  Spawned from CoPilot
                </span>
              </>
            )}
          </div>
        </div>

        {/* Instructions */}
        {instruction && (
          <div className="mb-7">
            <h3 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground mb-2.5">
              Instructions
            </h3>
            <div className="rounded-lg border bg-muted/40 px-3.5 py-3">
              <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
                {instruction}
              </p>
            </div>
          </div>
        )}

        {/* Reasoning trace */}
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <h3 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
              Reasoning trace
            </h3>
          </div>
          {traceError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50/40 px-4 py-3 text-[12px] text-rose-600">
              {traceError}
            </div>
          ) : traceSteps.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-[12px] text-muted-foreground">
              {traceLoadedRef.current
                ? 'No execution events yet. Trace will appear once execution begins.'
                : 'Loading trace…'}
            </div>
          ) : (
            <div>
              <TraceProgressBar steps={traceSteps} startedAt={item.started_at} />
              {traceSteps.map((step, i, arr) => (
                <TraceLine
                  key={step.id}
                  step={step}
                  isLast={i === arr.length - 1}
                  canDecide={canDecide}
                  onDecision={async (input) => {
                    if (!taskId) return;
                    const res = await fetch(
                      `/api/workforce-queue/${taskId}/decision`,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(input),
                      },
                    );
                    if (!res.ok) {
                      const body = (await res.json().catch(() => null)) as
                        | { error?: string }
                        | null;
                      throw new Error(
                        body?.error ?? `Decision failed (HTTP ${res.status})`,
                      );
                    }
                    // Refetch task status + trace immediately so the UI
                    // reflects the new state before the next poll tick.
                    const [taskRes, traceRes] = await Promise.all([
                      fetch(`/api/workforce-queue/${taskId}`),
                      fetch(`/api/workforce-queue/${taskId}/trace`),
                    ]);
                    if (taskRes.ok) {
                      const data = (await taskRes.json()) as {
                        item?: ApiQueueItem;
                      };
                      setItem(data.item ?? null);
                    }
                    if (traceRes.ok) {
                      const data = (await traceRes.json()) as {
                        steps?: TraceData[];
                        canDecide?: boolean;
                      };
                      setTraceSteps(data.steps ?? []);
                      setCanDecide(Boolean(data.canDecide));
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 border-t bg-card px-9 py-3.5">
        <div
          className={cn(
            'flex items-stretch gap-2 rounded-xl border bg-card pl-3.5 pr-1 py-1',
            composerMode === 'disabled' && 'opacity-60',
          )}
        >
          <textarea
            rows={1}
            disabled={composerDisabled}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void handleComposerSubmit();
              }
            }}
            placeholder={
              composerMode === 'fork'
                ? 'Send a follow-up instruction…'
                : 'Reply to the Workforce or add a new instruction…'
            }
            className="flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <button
            type="button"
            disabled={composerDisabled || !composerText.trim()}
            onClick={() => void handleComposerSubmit()}
            className="self-stretch w-9 grid place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <p
          className={cn(
            'mt-2 text-[11px] inline-flex items-center gap-1.5',
            composerMode === 'disabled'
              ? 'text-muted-foreground/70'
              : 'text-muted-foreground',
          )}
        >
          <AlertCircle className="h-3 w-3" />
          {composerHint}
        </p>
        {composerError && (
          <div className="mt-1.5 rounded-md border border-rose-200 bg-rose-50/60 px-2.5 py-1.5 text-[11px] text-rose-700">
            {composerError}
          </div>
        )}
        {composerToast && (
          <div className="mt-1.5 rounded-md border border-emerald-200 bg-emerald-50/60 px-2.5 py-1.5 text-[11px] text-emerald-700">
            {composerToast}
          </div>
        )}
      </div>
    </main>
  );
}
