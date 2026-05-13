'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Inbox, Send, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

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
}

const STATUS_TONE: Record<WorkforceQueueStatus, { label: string; color: string; dot: string }> = {
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

export function TaskCanvas({ taskId }: { taskId: string | null }) {
  const [item, setItem] = useState<ApiQueueItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const tone = STATUS_TONE[item.status];

  return (
    <main className="flex flex-col min-h-0 bg-card">
      <div className="flex-1 overflow-y-auto px-9 py-6">
        {/* Task header */}
        <div className="space-y-2.5 mb-7">
          <div className="inline-flex items-center gap-2 text-[11px] font-bold tracking-wider uppercase">
            <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />
            <span className={tone.color}>{tone.label}</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground font-mono">
              #{item.id.slice(0, 8)}
            </span>
          </div>
          <h2 className="text-[22px] font-extrabold tracking-tight leading-tight">
            {title}
          </h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
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

        {/* Reasoning trace — no execution layer yet, so render an empty state */}
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <h3 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
              Reasoning trace
            </h3>
          </div>
          <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-[12px] text-muted-foreground">
            No execution events yet.
            <div className="mt-1 text-[11px] text-muted-foreground/70">
              The Workforce executor isn&apos;t wired up — queued tasks won&apos;t run until it is.
            </div>
          </div>
        </div>
      </div>

      {/* Composer (disabled — execution layer not wired) */}
      <div className="flex-shrink-0 border-t bg-card px-9 py-3.5">
        <div className="flex items-stretch gap-2 rounded-xl border bg-card pl-3.5 pr-1 py-1 opacity-60">
          <textarea
            rows={1}
            disabled
            placeholder="Reply to the Workforce or add a new instruction…"
            className="flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            disabled
            className="self-stretch w-9 grid place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground/70 inline-flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3" />
          Replies will be enabled once the executor is wired.
        </p>
      </div>
    </main>
  );
}
