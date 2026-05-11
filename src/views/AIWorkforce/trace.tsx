'use client';

import { useState } from 'react';
import { AlertCircle, Check, ChevronRight, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { avatarToneClass } from './shared';
import type {
  InterventionData,
  ToolCall,
  TraceData,
  TraceStepStatus,
} from './shared';

export function TraceLine({
  step,
  isLast,
}: {
  step: TraceData;
  isLast: boolean;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[22px_1fr] gap-2.5 py-2.5',
        !isLast && 'border-b border-border/60',
      )}
    >
      <div className="pt-0.5">
        <TraceRing status={step.status} />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{step.title}</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground leading-relaxed">
          {step.description}
        </p>
        <p className="mt-1 text-[10px] font-mono text-muted-foreground/70">
          {step.timestamp}
        </p>

        {step.toolCalls && step.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {step.toolCalls.map((tc, i) => (
              <ToolCallView key={i} call={tc} />
            ))}
          </div>
        )}

        {step.intervention && <InterventionCard intervention={step.intervention} />}
      </div>
    </div>
  );
}

function TraceRing({ status }: { status: TraceStepStatus }) {
  if (status === 'done' || status === 'intervention-resolved') {
    return (
      <span className="h-4 w-4 rounded-full border-2 border-emerald-400 bg-emerald-50 grid place-items-center">
        <Check className="h-2.5 w-2.5 text-emerald-600" strokeWidth={3.5} />
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span className="h-4 w-4 rounded-full border-2 border-amber-500 bg-amber-50 grid place-items-center">
        <span className="h-1 w-1 rounded-full bg-amber-500 animate-pulse" />
      </span>
    );
  }
  // intervention-waiting
  return (
    <span className="h-4 w-4 rounded-full border-2 border-violet-500 bg-violet-50 grid place-items-center">
      <span className="text-[9px] font-extrabold leading-none text-violet-600">?</span>
    </span>
  );
}

function ToolCallView({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const hasOutput = !!call.output && call.output.rows.length > 0;
  return (
    <div
      className={cn(
        'rounded-md border font-mono overflow-hidden transition-colors',
        call.running
          ? 'border-amber-200 bg-amber-50/60'
          : 'border-border bg-muted/30 hover:border-border',
      )}
    >
      <button
        type="button"
        disabled={!hasOutput}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-left',
          hasOutput ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <ChevronRight
          className={cn(
            'h-2.5 w-2.5 text-muted-foreground transition-transform flex-shrink-0',
            open && 'rotate-90',
            !hasOutput && 'opacity-0',
          )}
        />
        <span
          className={cn(
            'font-semibold flex-shrink-0',
            call.running ? 'text-amber-600' : 'text-violet-700',
          )}
        >
          {call.name}
        </span>
        <span className="text-muted-foreground truncate">{call.args}</span>
        {call.status && (
          <span
            className={cn(
              'ml-auto inline-flex items-center gap-1 text-[10px] flex-shrink-0',
              call.running ? 'text-amber-600 font-semibold' : 'text-muted-foreground',
            )}
          >
            {call.running && (
              <span className="h-2 w-2 rounded-full border-[1.5px] border-current border-t-transparent animate-spin" />
            )}
            {call.status}
          </span>
        )}
      </button>
      {open && hasOutput && call.output && (
        <div className="border-t bg-card px-3 py-2 text-[11px] text-muted-foreground max-h-60 overflow-y-auto">
          <div className="mb-1.5 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground/80 font-sans">
            {call.output.label}
          </div>
          <div className="space-y-1">
            {call.output.rows.map((row, i) => (
              <div
                key={i}
                className="py-0.5 border-b border-dashed border-border last:border-b-0"
              >
                {row.key && <span className="text-muted-foreground">{row.key} · </span>}
                <span
                  className={cn(
                    'font-medium',
                    row.tone === 'pass' && 'text-emerald-600',
                    row.tone === 'fail' && 'text-red-600',
                    row.tone === 'warn' && 'text-amber-600',
                    (!row.tone || row.tone === 'default') && 'text-foreground',
                  )}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InterventionCard({ intervention }: { intervention: InterventionData }) {
  const [composerOpen, setComposerOpen] = useState(false);

  if (intervention.state === 'resolved') {
    const { question, resolution } = intervention;
    return (
      <div className="mt-2 rounded-lg border bg-muted/40 px-3.5 py-3">
        <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
          <Check className="h-3 w-3 text-emerald-500" strokeWidth={3} />
          Resolved
        </div>
        <p className="text-sm font-semibold mb-2">{question}</p>
        <div className="rounded-md border bg-card px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
            <span
              className={cn(
                'h-3.5 w-3.5 rounded-full grid place-items-center text-[7px] font-bold',
                avatarToneClass[resolution.avatarTone],
              )}
            >
              {resolution.actorInitials}
            </span>
            <span>{resolution.actor}</span>
            <span
              className={cn(
                'px-1.5 py-px rounded text-[9px] font-bold',
                resolution.decision === 'approved'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-violet-50 text-violet-700',
              )}
            >
              {resolution.decision === 'approved' ? 'Approved' : 'Modified'}
            </span>
            <span className="ml-auto text-[10px] font-mono font-medium">
              {resolution.timestamp}
            </span>
          </div>
          <p className="text-xs text-muted-foreground italic leading-relaxed">
            {resolution.text}
          </p>
        </div>
      </div>
    );
  }

  // Waiting state
  return (
    <div className="relative mt-2 rounded-lg border-[1.5px] border-violet-300 bg-gradient-to-br from-violet-50/70 to-indigo-50/50 px-3.5 py-3 overflow-hidden">
      <span className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-500 to-indigo-500" />
      <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-violet-600 mb-2">
        <AlertCircle className="h-3 w-3" />
        Waiting on input
      </div>
      <p className="text-sm font-semibold text-foreground mb-2 leading-snug">
        {intervention.question}
      </p>
      {intervention.proposal && (
        <div className="rounded-md border bg-card px-3 py-2 mb-2.5 text-xs text-muted-foreground leading-relaxed">
          {intervention.proposal}
        </div>
      )}
      {!composerOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-violet-600 hover:to-indigo-700 transition-colors"
          >
            <Check className="h-3 w-3" strokeWidth={3} />
            Approve
          </button>
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="inline-flex items-center rounded-md border border-violet-300 bg-card px-3 py-1.5 text-xs font-semibold text-violet-700 hover:border-violet-500 transition-colors"
          >
            Add custom instruction
          </button>
        </div>
      ) : (
        <div className="flex items-stretch gap-1.5 rounded-md border-[1.5px] border-violet-500 bg-card pl-3 pr-1 py-1">
          <textarea
            autoFocus
            rows={1}
            placeholder="e.g. 'Drop it — we don't bend on growth criteria'…"
            className="flex-1 resize-none bg-transparent py-1.5 text-xs outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            className="self-stretch w-7 grid place-items-center rounded bg-gradient-to-br from-violet-500 to-indigo-600 text-white hover:from-violet-600 hover:to-indigo-700 transition-colors"
          >
            <Send className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
