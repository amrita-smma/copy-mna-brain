'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileText, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { usePageContext } from '@/lib/chat/pageContextStore';
import { getInsightChatContext } from '@/lib/api/insights';
// Type only: the outline builder is server-side (node-html-parser).
import type { InsightChatContext } from '@/lib/insights/types';

export type InsightContextState =
  | { status: 'loading' }
  | { status: 'ready'; context: InsightChatContext }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/**
 * What the "context in use" panel shows for one state. Presentational, so the
 * testids and the truncation notice can be checked without a browser.
 */
export function InsightContextPanel({ state }: { state: InsightContextState }) {
  return (
    <div data-testid="copilot-context-panel" className="flex max-h-[70vh] flex-col">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-foreground">Context in use</p>
        {state.status === 'ready' ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {state.context.name} · version {state.context.versionNo}
            {/^\d{4}-\d{2}-\d{2}/.test(state.context.publishedAt)
              ? ` · published ${state.context.publishedAt.slice(0, 10)}`
              : ''}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          Sent to CoPilot with every message while this insight is open.
        </p>
      </div>
      {state.status === 'ready' && state.context.truncated ? (
        <div
          data-testid="copilot-context-truncated"
          role="note"
          className="mx-4 mt-3 flex gap-2 rounded-md border border-amber-500 bg-muted px-3 py-2 text-xs text-foreground"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span>
            This insight is larger than the context budget, so part of it was left out. Table rows and
            paragraph text go first; section names, headings, table headers and definitions stay. The
            note at the end lists what was dropped.
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state.status === 'loading' ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Loading the context…
          </div>
        ) : state.status === 'missing' ? (
          <p className="text-xs text-muted-foreground">
            This insight is no longer available, so no insight context is sent.
          </p>
        ) : state.status === 'error' ? (
          <p className="text-xs text-destructive">Could not load the context: {state.message}</p>
        ) : (
          <pre
            data-testid="copilot-context-outline"
            className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground"
          >
            {state.context.outline}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * The CoPilot header's "Context" control (MB-550): shown while an insight is
 * open, it opens a panel with the exact outline each chat turn carries. The
 * outline is fetched when the panel opens, from the same service call the chat
 * route makes, so what the user reads is what the model got.
 */
export function InsightContextButton({ className }: { className?: string }) {
  const insightId = usePageContext()?.insightId;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<InsightContextState>({ status: 'loading' });
  const requestSeq = useRef(0);

  const load = useCallback(async (id: string) => {
    const seq = ++requestSeq.current;
    setState({ status: 'loading' });
    try {
      const context = await getInsightChatContext(id);
      if (seq === requestSeq.current) setState({ status: 'ready', context });
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      if ((err as { status?: number })?.status === 404) {
        setState({ status: 'missing' });
      } else {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
  }, []);

  // Refetched on every open, so a version published since the last look shows.
  useEffect(() => {
    if (open && insightId) void load(insightId);
  }, [open, insightId, load]);

  // Leaving the insight closes the panel with it.
  useEffect(() => {
    if (!insightId) setOpen(false);
  }, [insightId]);

  if (!insightId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="copilot-context-button"
          aria-label="Show the insight context sent to CoPilot"
          title="Context in use"
          className={cn(
            'inline-flex shrink-0 items-center rounded-md border border-border bg-muted p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          {/* Icon-only: the docked header is narrow, and the agent label next to
              it must keep room for the agent's handle. */}
          <FileText className="h-3.5 w-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(32rem,calc(100vw-2rem))] bg-popover p-0"
      >
        <InsightContextPanel state={state} />
      </PopoverContent>
    </Popover>
  );
}
