'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, ListPlus, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TraceLine } from './trace';
import type { InterventionDecisionInput } from './trace';
import type { Routine, RoutineRunStatus, TraceData } from './shared';

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

// Polled while a run is non-terminal so the inline trace + decision UI
// stays current. Mirrors TaskCanvas's poll cadence; cleared on collapse or
// terminal status.
const TRACE_POLL_MS = 2000;
const IN_PROGRESS_STATUSES: WorkforceQueueStatus[] = [
  'pending',
  'running',
  'waiting_for_human_input',
  'waiting_for_subagent',
  'resume_ready',
];

const runStatusToneClass: Record<RoutineRunStatus, string> = {
  done: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  running: 'bg-amber-50 text-amber-700',
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
}: {
  routine: Routine;
  onDelete?: () => void | Promise<void>;
  // Called when the user clicks the Edit button. Parent opens the routine
  // modal in edit mode prefilled with the current routine's values.
  onEdit?: () => void;
  onEnqueued?: () => void | Promise<void>;
}) {
  const [runs, setRuns] = useState<DisplayRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [enqueuing, setEnqueuing] = useState(false);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);

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
    <main className="flex flex-col min-h-0 bg-card">
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

        {/* Summary card */}
        <div className="relative rounded-xl border bg-gradient-to-br from-violet-50/30 to-card px-5 py-4 mb-7 overflow-hidden">
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
              onClick={handleAddToQueue}
              disabled={enqueuing}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ListPlus className="h-3 w-3" />
              {enqueuing ? 'Adding…' : 'Add to current queue'}
            </button>
            <button
              type="button"
              onClick={onEdit}
              disabled={!onEdit}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-red-700 hover:border-red-200 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          </div>
          {enqueueError && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[12px] text-red-700">
              {enqueueError}
            </div>
          )}
        </div>

        {/* Run history */}
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
              Run history
            </h3>
            <span className="text-[11px] text-muted-foreground/70">
              {routine.runCount} runs total
            </span>
          </div>
          {runsLoading ? (
            <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center text-xs text-muted-foreground">
              Loading run history…
            </div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center text-xs text-muted-foreground">
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

  const isInProgress = IN_PROGRESS_STATUSES.includes(run.rawStatus);

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
      };
      setTrace(data.steps ?? []);
      setCanDecide(Boolean(data.canDecide));
      setTraceError(null);
    } catch (err) {
      setTraceError(err instanceof Error ? err.message : 'Failed to load trace');
    }
  }, [run.id]);

  // Lazy-fetch on first open; then poll every 2s while the run is still
  // active and the card is expanded. Collapsing or reaching a terminal
  // status stops the polling.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const run1 = async () => {
      if (trace === null) setTraceLoading(true);
      try {
        await fetchTrace();
      } finally {
        if (!cancelled) setTraceLoading(false);
      }
    };
    void run1();

    if (!isInProgress) {
      return () => {
        cancelled = true;
      };
    }
    const intervalId = window.setInterval(fetchTrace, TRACE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
    // We intentionally don't depend on `trace` — that would re-arm the
    // interval on every poll. The setTraceLoading-on-null check is just a
    // first-paint cue; subsequent polls update silently.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isInProgress, fetchTrace]);

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
        onClick={handleToggle}
        className="w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-muted/30 transition-colors"
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
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-violet-700 flex-shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-500 animate-pulse" />
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
            <div className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[12px] text-red-700">
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
