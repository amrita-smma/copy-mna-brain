'use client';

import { useState } from 'react';
import {
  AlertCircle,
  ArrowUp,
  BarChart3,
  Building2,
  Check,
  ChevronRight,
  Database,
  FileSearch,
  FileText,
  GitCompare,
  Globe,
  Loader2,
  Minus,
  Plus,
  Search,
  Send,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { avatarToneClass } from './shared';
import type {
  InterventionData,
  LiveRow,
  ToolCall,
  ToolCallRowTone,
  TraceData,
  TraceOutcomeChip,
  TraceStepStatus,
} from './shared';

export type InterventionDecisionInput = {
  tool_call_id: string;
  tool_name: string;
  decision: 'approve' | 'reject';
  rejection_message?: string;
};

// Per-tool contextual icon. Falls back to a generic Wrench for unknown tools.
const TOOL_ICONS: Record<string, LucideIcon> = {
  query_companies: Database,
  query_files: FileSearch,
  get_company_details: Building2,
  get_company_stats: BarChart3,
  get_data_schema: Database,
  web_search: Globe,
  add_company: Plus,
  generate_relationship_graph: GitCompare,
  promote_to_l1: ArrowUp,
  inven_paid_data_source_search: Search,
  inven_paid_data_source_enrichment: Sparkles,
};

function iconForTool(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? Wrench;
}

// Background color for the connector segment leaving this step toward the
// next one. Done → emerald, active → amber gradient, pending/skipped → muted
// grey.
function connectorClass(status: TraceStepStatus): string {
  if (status === 'done' || status === 'intervention-resolved') {
    return 'bg-emerald-400';
  }
  if (status === 'failed') {
    return 'bg-rose-400';
  }
  if (status === 'active' || status === 'intervention-waiting') {
    return 'bg-gradient-to-b from-emerald-400 to-amber-400';
  }
  return 'bg-border';
}

export function TraceLine({
  step,
  isLast,
  onDecision,
  canDecide = false,
}: {
  step: TraceData;
  isLast: boolean;
  onDecision?: (input: InterventionDecisionInput) => void | Promise<void>;
  canDecide?: boolean;
}) {
  const [reportOpen, setReportOpen] = useState(false);
  const isDone =
    step.status === 'done' || step.status === 'intervention-resolved';
  const isActive =
    step.status === 'active' || step.status === 'intervention-waiting';
  const isPending = step.status === 'pending';
  const isSkipped = step.status === 'skipped';
  // Both pending and skipped share the same "no body content, muted card"
  // treatment — neither has tool calls or a meaningful timestamp.
  const isPlaceholder = isPending || isSkipped;

  // Mini per-step progress: count tool calls with resolved output vs total.
  // Only rendered for the active step with more than one tool call.
  const progress = (() => {
    if (!isActive || !step.toolCalls || step.toolCalls.length <= 1) return null;
    const done = step.toolCalls.filter((tc) => !tc.running).length;
    return { done, total: step.toolCalls.length };
  })();

  return (
    <div className="relative grid grid-cols-[32px_1fr] gap-3.5 pb-5 last:pb-0">
      {/* Connector line — drawn from the bottom of this node to the top of
          the next. Hidden on the last step. */}
      {!isLast && (
        <span
          aria-hidden
          className={cn(
            'absolute left-[15px] top-9 bottom-0 w-[1.5px]',
            connectorClass(step.status),
          )}
        />
      )}

      <TraceNode step={step} />

      <div
        className={cn(
          'rounded-xl border bg-card overflow-hidden transition-shadow',
          isDone && 'border-emerald-200/70',
          isActive && 'border-amber-300/70 shadow-[0_0_0_3px_rgba(245,158,11,0.08)]',
          isPlaceholder && 'border-border/70 bg-muted/30',
        )}
      >
        <div className="px-3.5 py-3">
          <div className="flex items-start justify-between gap-2.5 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[10px] font-bold tracking-wider text-muted-foreground/80">
                STEP {step.stepNumber}
              </span>
              <p
                className={cn(
                  'text-[13.5px] font-bold leading-snug',
                  isPlaceholder ? 'text-muted-foreground' : step.status === 'failed' ? 'text-rose-700' : 'text-foreground',
                  // Skipped steps were on the plan but never ran — strike
                  // them through so the "wouldn't happen" intent reads at a
                  // glance, not just from the badge.
                  isSkipped && 'line-through',
                )}
              >
                {step.title}
              </p>
            </div>
            <StatusBadge status={step.status} />
          </div>

          {step.description && (
            <p
              className={cn(
                'text-[12px] leading-relaxed mb-1.5',
                isPlaceholder ? 'text-muted-foreground/70' : 'text-muted-foreground',
              )}
            >
              {step.description}
            </p>
          )}

          {(step.timestamp || step.outcomeChips?.length) && !isPlaceholder && (
            <div className="flex items-center gap-2.5 flex-wrap">
              {step.timestamp && (
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  {step.timestamp}
                </span>
              )}
              {step.outcomeChips?.map((chip, i) => (
                <OutcomeChip key={i} chip={chip} />
              ))}
            </div>
          )}

          {progress && (
            <div className="flex items-center gap-2 mt-2">
              <div className="flex-1 h-[3px] rounded-full bg-amber-100 overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full relative overflow-hidden"
                  style={{
                    width: `${Math.max(8, (progress.done / progress.total) * 100)}%`,
                  }}
                >
                  <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/60 to-transparent animate-shimmer" />
                </div>
              </div>
              <span className="font-mono text-[10px] font-semibold text-amber-700 flex-shrink-0">
                {progress.done} / {progress.total}
              </span>
            </div>
          )}

          {step.fullReport && (
            <button
              type="button"
              data-testid="trace-view-report-button"
              onClick={() => setReportOpen(true)}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 hover:border-blue-300 transition-colors"
            >
              <FileText className="h-3 w-3" strokeWidth={2.5} />
              View full report
            </button>
          )}
        </div>

        {step.toolCalls && step.toolCalls.length > 0 && (
          <div className="border-t bg-muted/30 px-3.5 py-2.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 mb-1.5 flex items-center gap-1.5">
              <Wrench className="h-2.5 w-2.5" />
              {step.status === 'intervention-waiting' &&
              step.toolCalls.some((tc) => tc.running)
                ? 'Waiting for user confirmation'
                : step.toolCalls.some((tc) => tc.running)
                  ? 'Tool running'
                  : 'Tools called'}
            </div>
            <div className="space-y-1">
              {step.toolCalls.map((tc, i) => (
                <ToolCallView
                  key={i}
                  call={tc}
                  awaitingApproval={step.status === 'intervention-waiting'}
                />
              ))}
            </div>
            {step.liveRows && step.liveRows.length > 0 && (
              <LiveOutputBlock rows={step.liveRows} />
            )}
          </div>
        )}

        {(!step.toolCalls || step.toolCalls.length === 0) &&
          step.liveRows &&
          step.liveRows.length > 0 && (
            <div className="border-t bg-muted/30 px-3.5 py-2.5">
              <LiveOutputBlock rows={step.liveRows} />
            </div>
          )}

        {step.intervention && (
          <div className="border-t px-3.5 py-3">
            <InterventionCard
              intervention={step.intervention}
              onDecision={onDecision}
              canDecide={canDecide}
            />
          </div>
        )}
      </div>

      {step.fullReport && (
        <Dialog open={reportOpen} onOpenChange={setReportOpen}>
          <DialogContent data-testid="trace-full-report-dialog" className="max-w-3xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-blue-600" />
                {step.title}
              </DialogTitle>
            </DialogHeader>
            <MarkdownRenderer content={step.fullReport} variant="card" />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function TraceNode({ step }: { step: TraceData }) {
  const ringBase = 'relative h-8 w-8 rounded-full grid place-items-center shrink-0 ring-2 ring-card';

  if (step.status === 'done' || step.status === 'intervention-resolved') {
    return (
      <span
        className={cn(
          ringBase,
          'bg-emerald-50 border-2 border-emerald-400 text-emerald-700',
        )}
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3.5} />
      </span>
    );
  }
  if (step.status === 'failed') {
    return (
      <span
        className={cn(
          ringBase,
          'bg-rose-50 border-2 border-rose-400 text-rose-700',
        )}
      >
        <span className="font-bold text-[14px] leading-none mb-[1px]">✗</span>
      </span>
    );
  }
  if (step.status === 'active') {
    return (
      <span
        className={cn(
          ringBase,
          'bg-amber-50 border-2 border-amber-500 text-amber-600',
        )}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
      </span>
    );
  }
  if (step.status === 'intervention-waiting') {
    return (
      <span
        className={cn(
          ringBase,
          'bg-blue-50 border-2 border-blue-500 text-blue-600',
        )}
      >
        <span className="text-[10px] font-extrabold leading-none">?</span>
      </span>
    );
  }
  if (step.status === 'skipped') {
    // Step was on the plan but never ran — flat muted dash to read as
    // "wasn't reached", distinct from the numbered pending circle.
    return (
      <span
        className={cn(
          ringBase,
          'bg-muted/40 border-2 border-border text-muted-foreground/70',
        )}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
    );
  }
  // pending
  return (
    <span
      className={cn(
        ringBase,
        'bg-card border-2 border-border text-muted-foreground font-mono text-[11px] font-bold',
      )}
    >
      {step.stepNumber}
    </span>
  );
}

function StatusBadge({ status }: { status: TraceStepStatus }) {
  const config: Record<TraceStepStatus, { label: string; className: string }> = {
    done: { label: 'Done', className: 'bg-emerald-50 text-emerald-700' },
    failed: { label: 'Failed', className: 'bg-rose-50 text-rose-700' },
    'intervention-resolved': {
      label: 'Done',
      className: 'bg-emerald-50 text-emerald-700',
    },
    active: { label: 'Running', className: 'bg-amber-50 text-amber-700' },
    'intervention-waiting': {
      label: 'Waiting',
      className: 'bg-blue-50 text-blue-700',
    },
    pending: { label: 'Pending', className: 'bg-muted text-muted-foreground' },
    skipped: { label: 'Skipped', className: 'bg-muted text-muted-foreground/70' },
  };
  const c = config[status];
  return (
    <span
      className={cn(
        'flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider',
        c.className,
      )}
    >
      {c.label}
    </span>
  );
}

function OutcomeChip({ chip }: { chip: TraceOutcomeChip }) {
  const toneClass = {
    pass: 'bg-emerald-50 text-emerald-700',
    fail: 'bg-rose-50 text-rose-700',
    warn: 'bg-amber-50 text-amber-700',
  }[chip.tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold',
        toneClass,
      )}
    >
      {chip.label}
    </span>
  );
}

const TONE_PILL_CLASS: Record<ToolCallRowTone, string> = {
  default: 'bg-muted text-muted-foreground',
  pass: 'bg-emerald-50 text-emerald-700',
  fail: 'bg-rose-50 text-rose-700',
  warn: 'bg-amber-50 text-amber-700',
};

function LiveOutputBlock({ rows }: { rows: LiveRow[] }) {
  const anyChecking = rows.some((r) => r.status === 'checking');
  return (
    <div className="mt-2 rounded-md border border-amber-200/70 bg-card overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border-b border-amber-200/60 text-[10px] font-bold uppercase tracking-wider text-amber-700">
        {anyChecking && (
          <Loader2 className="h-2.5 w-2.5 animate-spin" strokeWidth={2.5} />
        )}
        Live · partial output
      </div>
      <div className="px-2.5 py-1.5 space-y-0.5">
        {rows.map((row, i) => (
          <LiveOutputRow key={i} row={row} isLast={i === rows.length - 1} />
        ))}
      </div>
    </div>
  );
}

function LiveOutputRow({ row, isLast }: { row: LiveRow; isLast: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 py-1 font-mono text-[11px]',
        !isLast && 'border-b border-dashed border-border',
      )}
    >
      <span className="text-foreground font-medium min-w-[140px] flex-shrink-0 truncate">
        {row.label}
      </span>
      <LiveStatusIndicator row={row} />
    </div>
  );
}

function LiveStatusIndicator({ row }: { row: LiveRow }) {
  if (row.status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-700 truncate">
        <Check className="h-2.5 w-2.5 flex-shrink-0" strokeWidth={3.5} />
        <span className="truncate">{row.detail ?? 'done'}</span>
      </span>
    );
  }
  if (row.status === 'fail') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-rose-700 truncate">
        <span className="font-bold flex-shrink-0">✗</span>
        <span className="truncate">{row.detail ?? 'failed'}</span>
      </span>
    );
  }
  if (row.status === 'checking') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-amber-700 truncate">
        <Loader2
          className="h-2.5 w-2.5 animate-spin flex-shrink-0"
          strokeWidth={2.5}
        />
        <span className="truncate">{row.detail ?? 'checking…'}</span>
      </span>
    );
  }
  // pending
  return (
    <span className="text-[10.5px] text-muted-foreground/70 truncate">
      — {row.detail ?? 'pending'}
    </span>
  );
}

function ToolCallView({
  call,
  awaitingApproval = false,
}: {
  call: ToolCall;
  // True when the parent step is paused on a HITL interrupt — the call is
  // "running" in the LangGraph sense but actually waiting on the human, so we
  // recolor the row blue and relabel the pill instead of using the amber
  // "running" treatment that implies the agent is doing work.
  awaitingApproval?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasOutput = !!call.output && call.output.rows.length > 0;
  const Icon = iconForTool(call.name);
  const isWaiting = call.running && awaitingApproval;
  const pillClass = isWaiting
    ? 'bg-blue-50 text-blue-700'
    : call.running
      ? 'bg-amber-50 text-amber-700'
      : TONE_PILL_CLASS[call.tone ?? 'default'];

  return (
    <div
      className={cn(
        'rounded-md border bg-card overflow-hidden transition-colors',
        isWaiting
          ? 'border-blue-200 bg-blue-50/40'
          : call.running
            ? 'border-amber-200 bg-amber-50/40'
            : 'border-border hover:border-border/80',
      )}
    >
      <button
        type="button"
        disabled={!hasOutput}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-2 py-1.5 text-left',
          hasOutput ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <span
          className={cn(
            'h-[18px] w-[18px] rounded grid place-items-center flex-shrink-0',
            isWaiting
              ? 'bg-blue-100 text-blue-700'
              : call.running
                ? 'bg-amber-100 text-amber-600'
                : 'bg-blue-100 text-blue-700',
          )}
        >
          <Icon className="h-2.5 w-2.5" />
        </span>
        <ChevronRight
          className={cn(
            'h-2.5 w-2.5 text-muted-foreground transition-transform flex-shrink-0',
            open && 'rotate-90',
            !hasOutput && 'opacity-0',
          )}
        />
        <span
          className={cn(
            'font-mono text-[11.5px] font-semibold flex-shrink-0',
            isWaiting
              ? 'text-blue-700'
              : call.running
                ? 'text-amber-700'
                : 'text-blue-700',
          )}
        >
          {call.name}
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground truncate">
          {call.args}
        </span>
        {(call.status || call.running) && (
          <span
            className={cn(
              'ml-auto inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0',
              pillClass,
            )}
          >
            {isWaiting ? (
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
            ) : (
              call.running && (
                <Loader2 className="h-2 w-2 animate-spin" strokeWidth={3} />
              )
            )}
            {isWaiting
              ? 'waiting for user confirmation'
              : (call.status ?? 'running')}
          </span>
        )}
      </button>
      {open && hasOutput && call.output && (
        <div className="border-t bg-card px-3 py-2 text-[12px] text-muted-foreground max-h-96 overflow-y-auto font-sans">
          <div className="mb-1.5 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground/80">
            {call.output.label}
          </div>
          <div className="space-y-1">
            {call.output.rows.map((row, i) => (
              <div
                key={i}
                className={cn(
                  'last:border-b-0',
                  row.key && 'py-0.5 border-b border-dashed border-border',
                )}
              >
                {row.key ? (
                  <>
                    <span className="text-muted-foreground">{row.key} · </span>
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
                  </>
                ) : (
                  // Unstructured row — render value as markdown so tool
                  // outputs that ship with headers / bold / tables don't
                  // appear as raw syntax. Falls back to plain text when
                  // the content has no markdown markers.
                  <MarkdownRenderer content={row.value} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Top-of-trace summary: N segments tinted by per-step status, plus a
 * "Step X of Y · ~N min left" label. ETA is computed coarsely from elapsed
 * time divided by completed-step count — labelled with a "~" so users
 * read it as estimate rather than commitment. Returns null if there's
 * nothing useful to show (zero steps, or one step with no plan).
 */
export function TraceProgressBar({
  steps,
  startedAt,
}: {
  steps: TraceData[];
  startedAt: string | null;
}) {
  if (steps.length === 0) return null;

  const total = steps.length;
  const doneCount = steps.filter(
    (s) => s.status === 'done' || s.status === 'intervention-resolved',
  ).length;
  const activeIdx = steps.findIndex(
    (s) => s.status === 'active' || s.status === 'intervention-waiting',
  );
  const currentIdx = activeIdx >= 0 ? activeIdx : Math.max(0, doneCount - 1);

  const eta = computeEtaLabel(startedAt, doneCount, total);

  return (
    <div className="flex items-center justify-between gap-3 mb-3.5">
      <div className="flex items-center gap-1">
        {steps.map((s, i) => {
          const isDone =
            s.status === 'done' || s.status === 'intervention-resolved';
          const isFailed = s.status === 'failed';
          const isActive =
            s.status === 'active' || s.status === 'intervention-waiting';
          return (
            <span
              key={s.id}
              className={cn(
                'h-1 w-7 rounded-full transition-colors',
                isDone && 'bg-emerald-400',
                isFailed && 'bg-rose-400',
                isActive && 'bg-amber-500',
                !isDone && !isFailed && !isActive && 'bg-border',
              )}
              aria-label={`Step ${i + 1}: ${s.status}`}
            />
          );
        })}
      </div>
      <span className="font-mono text-[10.5px] text-muted-foreground">
        <strong className="text-foreground font-semibold">
          Step {currentIdx + 1}
        </strong>{' '}
        of {total}
        {eta && <> · {eta}</>}
      </span>
    </div>
  );
}

function computeEtaLabel(
  startedAt: string | null,
  doneCount: number,
  total: number,
): string | null {
  if (!startedAt || doneCount === 0 || doneCount >= total) return null;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  const elapsedMs = Date.now() - startedMs;
  if (elapsedMs <= 0) return null;
  const remainingMs = (elapsedMs / doneCount) * (total - doneCount);
  const sec = Math.round(remainingMs / 1000);
  if (sec < 60) return `~${sec}s left`;
  const min = Math.round(sec / 60);
  if (min < 60) return `~${min} min left`;
  const hr = Math.round(min / 60);
  return `~${hr}h left`;
}

function InterventionCard({
  intervention,
  onDecision,
  canDecide = false,
}: {
  intervention: InterventionData;
  onDecision?: (input: InterventionDecisionInput) => void | Promise<void>;
  canDecide?: boolean;
}) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [rejectMessage, setRejectMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (intervention.state === 'resolved') {
    const { question, resolution } = intervention;
    return (
      <div className="rounded-lg border bg-muted/40 px-3.5 py-3">
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
                  : 'bg-blue-50 text-blue-700',
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
  const toolCallId = intervention.tool_call_id;
  const toolName = intervention.tool_name;
  const decideAllowed = canDecide && !!onDecision && !!toolCallId && !!toolName;

  const submit = async (
    decision: 'approve' | 'reject',
    rejection_message?: string,
  ) => {
    if (!decideAllowed || submitting) return;
    setSubmitting(true);
    try {
      await onDecision!({
        tool_call_id: toolCallId!,
        tool_name: toolName!,
        decision,
        ...(rejection_message ? { rejection_message } : {}),
      });
    } finally {
      setSubmitting(false);
      setComposerOpen(false);
      setRejectMessage('');
    }
  };

  return (
    <div className="relative rounded-lg border-[1.5px] border-blue-300 bg-gradient-to-br from-blue-50/70 to-blue-50/50 px-3.5 py-3 overflow-hidden">
      <span className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-blue-500" />
      <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-blue-600 mb-2">
        <AlertCircle className="h-3 w-3" />
        Waiting on input
      </div>
      <p className="text-sm font-semibold text-foreground mb-2 leading-snug">
        {intervention.question}
      </p>
      {intervention.proposal && (
        <div className="rounded-md border bg-card px-3 py-2 mb-2.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-blue-600 mb-1">
            Why
          </div>
          {/* whitespace-pre-line so the "reason\n\nNote: …" composition from
              traceMapper renders as two paragraphs instead of collapsing the
              newlines. */}
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
            {intervention.proposal}
          </p>
        </div>
      )}
      {!decideAllowed ? (
        <p className="text-[11px] text-muted-foreground italic">
          Only the task creator can decide.
        </p>
      ) : !composerOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="intervention-approve-button"
            disabled={submitting}
            onClick={() => void submit('approve')}
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-blue-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-blue-600 hover:to-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Check className="h-3 w-3" strokeWidth={3} />
            Approve
          </button>
          <button
            type="button"
            data-testid="intervention-reject-button"
            disabled={submitting}
            onClick={() => setComposerOpen(true)}
            className="inline-flex items-center rounded-md border border-rose-300 bg-card px-3 py-1.5 text-xs font-semibold text-rose-700 hover:border-rose-500 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="flex items-stretch gap-1.5 rounded-md border-[1.5px] border-rose-400 bg-card pl-3 pr-1 py-1">
          <textarea
            autoFocus
            rows={1}
            value={rejectMessage}
            onChange={(e) => setRejectMessage(e.target.value)}
            placeholder="Reason (optional)…"
            disabled={submitting}
            className="flex-1 resize-none bg-transparent py-1.5 text-xs outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            data-testid="intervention-reject-send-button"
            disabled={submitting}
            onClick={() => void submit('reject', rejectMessage.trim() || undefined)}
            className="self-stretch w-7 grid place-items-center rounded bg-gradient-to-br from-rose-500 to-rose-600 text-white hover:from-rose-600 hover:to-rose-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Send className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
