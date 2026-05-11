'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Send, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TraceLine } from './trace';
import { traceSteps } from './data';
import { avatarToneClass } from './shared';

const TRACE_PAGE_SIZE = 10;

export function TaskCanvas() {
  const [visibleTraceCount, setVisibleTraceCount] = useState(TRACE_PAGE_SIZE);
  const [isLoadingMoreTraces, setIsLoadingMoreTraces] = useState(false);
  const traceSentinelRef = useRef<HTMLDivElement | null>(null);
  const visibleTraceSteps = traceSteps.slice(0, visibleTraceCount);
  const hasMoreTraces = visibleTraceCount < traceSteps.length;

  useEffect(() => {
    if (!hasMoreTraces) return;
    const node = traceSentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingMoreTraces) {
          setIsLoadingMoreTraces(true);
          window.setTimeout(() => {
            setVisibleTraceCount((c) =>
              Math.min(c + TRACE_PAGE_SIZE, traceSteps.length),
            );
            setIsLoadingMoreTraces(false);
          }, 250);
        }
      },
      { rootMargin: '120px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreTraces, isLoadingMoreTraces]);

  return (
    <main className="flex flex-col min-h-0 bg-card">
      <div className="flex-1 overflow-y-auto px-9 py-6">
        {/* Task header */}
        <div className="space-y-2.5 mb-7">
          <div className="inline-flex items-center gap-2 text-[11px] font-bold tracking-wider uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-500 animate-pulse" />
            <span className="text-violet-600">Waiting on input</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground">L0/L1 Screening</span>
          </div>
          <h2 className="text-[22px] font-extrabold tracking-tight leading-tight">
            Screening 5 inbound targets — Project Maple
          </h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <span className={cn('h-4 w-4 rounded-full grid place-items-center text-[8px] font-bold', avatarToneClass.amber)}>
                SC
              </span>
              Sarah Chen
            </span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <span>Started 8 min ago</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <button
              type="button"
              className="inline-flex items-center gap-1 text-violet-600 font-semibold hover:underline"
            >
              <Sparkles className="h-3 w-3" />
              Spawned from CoPilot
            </button>
          </div>
        </div>

        {/* Instructions */}
        <div className="mb-7">
          <h3 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground mb-2.5">
            Instructions
          </h3>
          <div className="rounded-lg border bg-muted/40 px-3.5 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={cn('h-4 w-4 rounded-full grid place-items-center text-[8px] font-bold', avatarToneClass.amber)}>
                SC
              </span>
              <span className="text-[11px] font-semibold text-muted-foreground">Sarah Chen</span>
              <span className="ml-auto text-[11px] font-mono text-muted-foreground">14:24</span>
            </div>
            <p className="text-sm text-foreground/90 leading-relaxed">
              Screen the 5 inbound targets in the Project Maple folder. Standard L0 + L1 criteria. Flag any borderline ones for me.
            </p>
          </div>
        </div>

        {/* Reasoning trace */}
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <h3 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
              Reasoning trace
            </h3>
            <span className="text-[11px] text-muted-foreground/70">
              Showing {visibleTraceSteps.length} of {traceSteps.length}
            </span>
          </div>

          <div>
            {visibleTraceSteps.map((step, idx) => (
              <TraceLine
                key={step.id}
                step={step}
                isLast={idx === visibleTraceSteps.length - 1 && !hasMoreTraces}
              />
            ))}
          </div>

          {hasMoreTraces ? (
            <div
              ref={traceSentinelRef}
              className="flex items-center justify-center py-4 text-xs text-muted-foreground"
            >
              {isLoadingMoreTraces ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading older steps…
                </span>
              ) : (
                <span className="text-muted-foreground/50">
                  Scroll to load older steps
                </span>
              )}
            </div>
          ) : (
            <div className="py-4 text-center text-[11px] text-muted-foreground/60">
              End of trace · {traceSteps.length} steps
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 border-t bg-card px-9 py-3.5">
        <div className="flex items-stretch gap-2 rounded-xl border bg-card pl-3.5 pr-1 py-1 focus-within:border-violet-500 transition-colors">
          <textarea
            rows={1}
            placeholder="Reply to the Workforce or add a new instruction…"
            className="flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            className="self-stretch w-9 grid place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white hover:from-violet-600 hover:to-indigo-700 transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground/70 inline-flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3" />
          Replies go to the Workforce running this task.
        </p>
      </div>
    </main>
  );
}
