'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronRight, ListPlus, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import { TraceLine } from './trace';
import type { InterventionDecisionInput } from './trace';
import type { Routine, RoutineRunStatus, TraceData } from './shared';
import { useVisibleInterval } from './shared';
import { useLiveRefetchInterval, useLiveTopic } from '@/components/live/LiveEventsProvider';
import { LIVE_TOPICS } from '@/lib/live/topics';

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

// While the live stream is down, how often an open, non-terminal run's trace
// is re-read so the inline trace + decision UI stays current. While it is up,
// the run's `workforce` (status) and `workforce-trace` (checkpoint) frames
// drive the refresh. Mirrors TaskCanvas; cleared on collapse or terminal status.
const TRACE_POLL_MS = 5000;
const IN_PROGRESS_STATUSES: WorkforceQueueStatus[] = [
  'pending',
  'running',
  'waiting_for_human_input',
  'waiting_for_subagent',
  'resume_ready',
];

const runStatusToneClass: Record<RoutineRunStatus, string> = {
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  running: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
};

const runStatusLabel: Record<RoutineRunStatus, string> = {
  done: 'Done',
  failed: 'Failed',
  running: 'Running',
};

interface ApiRoutineRun {
  id: string;
  status: WorkforceQueueStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
}

interface DisplayRun {
  id: string;
  status: RoutineRunStatus;
  // Raw workforce queue status so the card can decide whether to poll the
  // trace (in-progress) or render statically (terminal).
  rawStatus: WorkforceQueueStatus;
  startedAt: string;
  endedAt: string;
}

function mapApiRunToDisplay(row: ApiRoutineRun): DisplayRun {
  let status: RoutineRunStatus;
  if (row.status === 'succeeded') status = 'done';
  else if (
    row.status === 'failed' ||
    row.status === 'rejected' ||
    row.status === 'timed_out'
  )
    status = 'failed';
  else status = 'running';
  return {
    id: row.id,
    status,
    rawStatus: row.status,
    startedAt: row.started_at ?? row.created_at,
    endedAt: row.ended_at ?? '—',
  };
}

export function RoutineCanvas({
  routine,
  onDelete,
  onEdit,
  onEnqueued,
  onToggleEnabled,
}: {
  routine: Routine;
  onDelete?: () => void | Promise<void>;
  // Called when the user clicks the Edit button. Parent opens the routine
  // modal in edit mode prefilled with the current routine's values.
  onEdit?: () => void;
  onEnqueued?: () => void | Promise<void>;
  onToggleEnabled?: (next: boolean) => void | Promise<void>;
}) {
  const [runs, setRuns] = useState<DisplayRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [enqueuing, setEnqueuing] = useState(false);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  const insightHref = useWorkspaceHref(
    routine.insight ? `/insight/${routine.insight.id}` : '',
  );

  const handleToggleEnabled = async () => {
    if (!onToggleEnabled) return;
    setTogglingEnabled(true);
    try {
      await onToggleEnabled(!routine.enabled);
    } finally {
      setTogglingEnabled(false);
    }
  };

  const fetchRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/routines/${routine.id}/runs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: ApiRoutineRun[] };
      setRuns((data.items ?? []).map(mapApiRunToDisplay));
    } catch (err) {
      console.error('[RoutineCanvas] fetchRuns failed:', err);
    } finally {
      setRunsLoading(false);
    }
  }, [routine.id]);

  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!window.confirm(`Delete routine "${routine.name}"? This cannot be undone.`)) return;
    await onDelete();
  };

  const handleAddToQueue = async () => {
    setEnqueueError(null);
    setEnqueuing(true);
    try {
      const res = await fetch(`/api/routines/${routine.id}/runs`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Enqueue failed (HTTP ${res.status})`);
      }
      // Refresh this routine's run history + let the parent refresh the
      // workforce queue panel so the new task appears in "Queued" / "In
      // progress" without a page reload.
      await Promise.all([fetchRuns(), onEnqueued?.()]);
    } catch (err) {
      setEnqueueError(err instanceof Error ? err.message : 'Failed to enqueue');
    } finally {
      setEnqueuing(false);
    }
  };
  return (
    <main data-testid="routine-canvas" className="flex flex-col min-h-0 bg-card">
      <div className="flex-1 overflow-y-auto px-9 py-6">
        {/* Header */}
        <div className="space-y-2.5 mb-7">
          <div className="inline-flex items-center gap-2 text-[11px] font-bold tracking-wider uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-emerald-700">Standing Routine</span>
          </div>
          <h2 className="text-[22px] font-extrabold tracking-tight leading-tight">
            {routine.name}
          </h2>
          {routine.insight && (
            <p className="text-xs text-muted-foreground">
              Refreshes insight{' '}
              <Link
                href={insightHref}
                data-testid="routine-insight-link"
                className="font-semibold text-foreground underline hover:text-primary transition-colors"
              >
                {routine.insight.name}
              </Link>
            </p>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span>{routine.scheduleDetailed}</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <span>
              Created by{' '}
              <span className="font-semibold text-foreground/80">{routine.createdBy}</span>{' '}
              · {routine.createdAgo}
            </span>
          </div>
        </div>

        {/* Paused for a broken agent binding (MB-560): only a rebind resumes it,
            so Run now and Resume are disabled below. */}
        {routine.pausedNotice && (
          <div
            data-testid="routine-canvas-paused-reason"
            className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              {routine.pausedNotice}
              {routine.insight && (
                <>
                  {' '}
                  <Link
                    href={insightHref}
                    data-testid="routine-paused-insight-link"
                    className="font-semibold underline"
                  >
                    Open the insight
                  </Link>
                </>
              )}
            </span>
          </div>
        )}

        {/* Summary card */}
        <div className="relative rounded-xl border bg-card px-5 py-4 mb-7 overflow-hidden">
          <span className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500" />
          <div className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground pt-0.5">
              Schedule
            </div>
            <div>
              {routine.scheduleDetailed} · next run{' '}
              <span className="font-semibold">{routine.nextRun}</span>
            </div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground pt-0.5">
              Instruction
            </div>
            <div className="text-[12.5px] text-muted-foreground leading-relaxed">
              {routine.instruction}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-4 pt-3.5 border-t">
            <button
              type="button"
              data-testid="routine-add-to-queue-button"
              onClick={handleAddToQueue}
              disabled={enqueuing || Boolean(routine.pausedReason)}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ListPlus className="h-3 w-3" />
              {enqueuing ? 'Adding…' : 'Add to current queue'}
            </button>
            <button
              type="button"
              data-testid="routine-edit-button"
              onClick={onEdit}
              disabled={!onEdit}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
            <button
              type="button"
              data-testid="routine-toggle-enabled-button"
              onClick={handleToggleEnabled}
              disabled={!onToggleEnabled || togglingEnabled || Boolean(routine.pausedReason)}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {routine.enabled ? (
                <>
                  <Pause className="h-3 w-3" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" />
                  Resume
                </>
              )}
            </button>
            <button
              type="button"
              data-testid="routine-delete-button"
              onClick={handleDelete}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-red-700 hover:border-red-200 dark:hover:border-red-900 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          </div>
          {enqueueError && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
              {enqueueError}
            </div>
          )}
        </div>

        {/* Run history */}
        <div data-testid="routine-run-history">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
              Run history
            </h3>
            <span className="text-[11px] text-muted-foreground/70">
              {routine.runCount} runs total
            </span>
          </div>
          {runsLoading ? (
            <div className="rounded-lg border border-dashed bg-muted px-4 py-8 text-center text-xs text-muted-foreground">
              Loading run history…
            </div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted px-4 py-8 text-center text-xs text-muted-foreground">
              No runs yet — first run will appear here once it executes.
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <RunCard key={run.id} run={run} onDecisionResolved={fetchRuns} />
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function RunCard({
  run,
  onDecisionResolved,
}: {
  run: DisplayRun;
  // Called after a successful approve/reject so the parent can refetch the
  // run list — the run's status will flip from waiting_for_human_input to
  // running (and eventually to a terminal state).
  onDecisionResolved?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<TraceData[] | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [canDecide, setCanDecide] = useState(false);
  const [decisionSubmitting, setDecisionSubmitting] = useState(false);
  const [status, setStatus] = useState<WorkforceQueueStatus>(run.rawStatus);

  useEffect(() => {
    setStatus(run.rawStatus);
  }, [run.rawStatus]);

  const isInProgress = IN_PROGRESS_STATUSES.includes(status);

  // Pull `cancelled` semantics in via a ref-style closure isn't needed here
  // because we recreate fetchTrace on every render and the interval below
  // tears down on cleanup. Keep it simple.
  const fetchTrace = useCallback(async () => {
    try {
      const res = await fetch(`/api/workforce-queue/${run.id}/trace`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        steps?: TraceData[];
        canDecide?: boolean;
        status?: WorkforceQueueStatus;
      };
      setTrace(data.steps ?? []);
      setCanDecide(Boolean(data.canDecide));
      if (data.status) {
        setStatus(data.status);
      }
      setTraceError(null);
    } catch (err) {
      setTraceError(err instanceof Error ? err.message : 'Failed to load trace');
    }
  }, [run.id]);

  // Lazy-fetch on first open; re-fetch when run goes terminal.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    if (trace === null) setTraceLoading(true);
    fetchTrace().finally(() => {
      if (!cancelled) setTraceLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isInProgress, fetchTrace]);

  useVisibleInterval(fetchTrace, useLiveRefetchInterval(TRACE_POLL_MS), open && isInProgress);
  const onRunFrame = (ids: string[] | undefined) => {
    if (!open || !isInProgress || (ids && !ids.includes(run.id))) return;
    void fetchTrace();
  };
  useLiveTopic(LIVE_TOPICS.workforce, onRunFrame);
  useLiveTopic(LIVE_TOPICS.workforceTrace, onRunFrame);

  const handleToggle = () => setOpen((v) => !v);

  const handleDecision = async (input: InterventionDecisionInput) => {
    setDecisionSubmitting(true);
    try {
      const res = await fetch(`/api/workforce-queue/${run.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Decision failed (HTTP ${res.status})`);
      }
      // Refresh trace + bubble up so the parent re-fetches the run list (its
      // rawStatus needs to update — that's what controls polling).
      await Promise.all([fetchTrace(), onDecisionResolved?.()]);
    } finally {
      setDecisionSubmitting(false);
    }
  };

  return (
    <div
      className={cn(
        'rounded-xl border bg-card overflow-hidden transition-colors',
        open && 'border-foreground/20',
      )}
    >
      <button
        type="button"
        data-testid={`routine-run-toggle-${run.id}`}
        onClick={handleToggle}
        className="w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-muted transition-colors"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 text-muted-foreground transition-transform flex-shrink-0',
            open && 'rotate-90',
          )}
        />
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wider flex-shrink-0',
            runStatusToneClass[run.status],
          )}
        >
          {runStatusLabel[run.status]}
        </span>
        {/* Show a small "awaiting decision" pulse when the run is paused on
            HITL. Helps the user notice action is needed without expanding. */}
        {run.rawStatus === 'waiting_for_human_input' && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-blue-700 flex-shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
            Awaiting decision
          </span>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] min-w-0">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Started
          </span>
          <span className="font-mono font-medium text-foreground">{run.startedAt}</span>
          <span className="text-muted-foreground">→</span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Ended
          </span>
          <span className="font-mono font-medium text-foreground">{run.endedAt}</span>
        </div>
      </button>
      {open && (
        <div className="border-t px-3.5 pb-4 pt-3">
          <h4 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground mb-2">
            Reasoning Trace
          </h4>
          {traceLoading && trace === null && (
            <div className="text-xs text-muted-foreground/70 py-2">Loading trace…</div>
          )}
          {traceError && (
            <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
              {traceError}
            </div>
          )}
          {!traceError && trace && trace.length === 0 && !traceLoading && (
            <div className="text-xs text-muted-foreground/70 py-2">
              No trace events yet.
            </div>
          )}
          {!traceError && trace && trace.length > 0 && (
            <div className={cn(decisionSubmitting && 'opacity-60 pointer-events-none')}>
              {trace.map((step, idx) => (
                <TraceLine
                  key={step.id}
                  step={step}
                  isLast={idx === trace.length - 1}
                  canDecide={canDecide}
                  onDecision={handleDecision}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
