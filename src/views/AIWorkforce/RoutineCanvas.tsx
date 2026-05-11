'use client';

import { useState } from 'react';
import { ChevronRight, ListPlus, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TraceLine } from './trace';
import type { Routine, RoutineRun, RoutineRunStatus } from './shared';

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

export function RoutineCanvas({
  routine,
  runs,
}: {
  routine: Routine;
  runs: RoutineRun[];
}) {
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
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground hover:border-border transition-colors"
            >
              <ListPlus className="h-3 w-3" />
              Add to current queue
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground hover:border-border transition-colors"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground hover:text-red-700 hover:border-red-200 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          </div>
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
          {runs.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center text-xs text-muted-foreground">
              No runs yet — first run will appear here once it executes.
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((run, idx) => (
                <RunCard key={run.id} run={run} defaultOpen={idx === 0} />
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
  defaultOpen = false,
}: {
  run: RoutineRun;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={cn(
        'rounded-xl border bg-card overflow-hidden transition-colors',
        open && 'border-foreground/20',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3.5 py-3 text-left"
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
          <div>
            {run.trace.map((step, idx) => (
              <TraceLine
                key={step.id}
                step={step}
                isLast={idx === run.trace.length - 1}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
