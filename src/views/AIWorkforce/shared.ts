import { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { RoutinePausedReason } from '@/lib/routines/pauseReason';

export type AvatarTone = 'amber' | 'indigo' | 'aqua' | 'rose' | 'slate' | 'violet';

export const avatarToneClass: Record<AvatarTone, string> = {
  amber: 'bg-gradient-to-br from-amber-400 to-amber-600 text-white',
  indigo: 'bg-gradient-to-br from-blue-500 to-blue-600 text-white',
  aqua: 'bg-gradient-to-br from-emerald-400 to-teal-600 text-white',
  rose: 'bg-gradient-to-br from-pink-400 to-rose-600 text-white',
  slate: 'bg-gradient-to-br from-slate-500 to-slate-700 text-white',
  violet: 'bg-blue-100 text-blue-700',
};

export type QueueTask = {
  id: string;
  title: string;
  owner: string;
  initials: string;
  avatarTone: AvatarTone;
  icon: LucideIcon;
  // Set when the task was spawned by a routine. Lets the sidebar attribute
  // running/done tasks to their source routine and offer a one-click jump.
  routineId?: string;
  routineName?: string;
  // Short relative-time badge (e.g. "8m", "2h"). Per-section meaning:
  //   queued    → time since created_at
  //   running   → time since started_at (falls back to created_at)
  //   done      → time since ended_at (falls back to created_at)
  relTime?: string;
  // Queued tasks only: how many rows GLOBALLY (any workspace) are ahead of
  // this one under the shared single-worker queue. null/undefined for
  // non-queued tasks, or if the server hasn't computed it (e.g. this task's
  // status flipped between the list fetch and render).
  aheadGlobally?: number | null;
  // Subset of aheadGlobally belonging to a workspace other than this one.
  // Excludes same-workspace resume_ready rows, which aheadGlobally counts
  // but which aren't "another workspace's" job — see
  // AiWorkforceQueueRepository.getGlobalQueuePositions.
  aheadOtherWorkspaces?: number | null;
};

export type DoneTask = {
  title: string;
  owner: string;
  initials: string;
  avatarTone: AvatarTone;
  meta: string;
};

export type TraceStepStatus =
  | 'done'
  | 'failed'
  | 'active'
  | 'pending'
  | 'skipped'
  | 'intervention-waiting'
  | 'intervention-resolved';

export type ToolCallRowTone = 'default' | 'pass' | 'fail' | 'warn';

export type ToolCallRow = {
  key?: string;
  value: string;
  tone?: ToolCallRowTone;
};

export type ToolCall = {
  name: string;
  args: string;
  status?: string;
  // Maps the heuristic status label to a colored pill. Mapper sets this
  // alongside `status`; UI uses it to pick the pill color.
  tone?: ToolCallRowTone;
  running?: boolean;
  output?: {
    label: string;
    rows: ToolCallRow[];
  };
};

// Step-level summary chip, one per noteworthy outcome in this step (typically
// derived from each tool call's resolved status + tone).
export type TraceOutcomeChip = {
  label: string;
  tone: 'pass' | 'fail' | 'warn';
};

// Per-item snapshot of an in-flight iteration. Populated by the agent via
// the `report_progress` tool; rendered as the "Live · partial output" block
// on a trace step.
export type LiveRowStatus = 'pending' | 'checking' | 'done' | 'fail';

export type LiveRow = {
  label: string;
  status: LiveRowStatus;
  // Short result/reason text shown next to the status (e.g. "match",
  // "EBITDA too thin", "kept"). Omitted when the row hasn't been touched.
  detail?: string;
};

// An ask_owner intervention (MB-561): the agent's question carries its
// recommended answer, the reasoning, and optional one-click answers.
export type InterventionAsk = {
  recommendation: string;
  rationale?: string;
  options?: string[];
};

export type InterventionData =
  | {
      state: 'waiting';
      question: string;
      proposal?: string;
      // Identifies the tool call being gated. Required for the decision
      // endpoint to know what to resume.
      tool_call_id?: string;
      tool_name?: string;
      // Set for ask_owner: rendered as recommendation + answer controls
      // instead of Approve/Reject.
      ask?: InterventionAsk;
      // Display name of the person the intervention is addressed to.
      waitingFor?: string;
    }
  | {
      state: 'resolved';
      question: string;
      resolution: {
        actor: string;
        actorInitials: string;
        avatarTone: AvatarTone;
        decision: 'approved' | 'modified' | 'answered' | 'rejected';
        text: string;
        timestamp: string;
      };
    };

export type TraceData = {
  id: string;
  status: TraceStepStatus;
  // 1-based position in the trace. Mapper assigns; UI renders as "STEP N".
  stepNumber: number;
  title: string;
  description: string;
  timestamp: string;
  // Full, untruncated text of a final-response step (the agent's closing
  // report). `description` is truncated for the inline card; this holds the
  // complete markdown so the UI can render it in a popup. Set only on
  // text-only steps (no tool calls) with non-empty content.
  fullReport?: string;
  toolCalls?: ToolCall[];
  // Summarises the step's outcomes (e.g. "5 matches", "1 eliminated") for
  // the meta row. Empty/undefined for steps with no resolved tool calls.
  outcomeChips?: TraceOutcomeChip[];
  // Snapshot of an in-flight iteration the agent reported via the
  // `report_progress` tool. Rendered as the "Live · partial output" block.
  liveRows?: LiveRow[];
  intervention?: InterventionData;
  // Companies the step names that a tool resolved to an id, in first-mention
  // order. Rendered as "Open <company>" chips under the step.
  companies?: { id: string; name: string }[];
};

export type Routine = {
  id: string;
  name: string;
  scheduleSummary: string;
  scheduleDetailed: string;
  nextRun: string;
  createdBy: string;
  createdAgo: string;
  instruction: string;
  runCount: number;
  isFiring?: boolean;
  enabled: boolean;
  /**
   * Set when the system paused the routine for a broken agent binding
   * (MB-560), as opposed to a manual pause. Only a rebind resumes it.
   */
  pausedReason: RoutinePausedReason | null;
  /** Plain-words notice for `pausedReason`, naming the agent. */
  pausedNotice: string | null;
  insight: { id: string; name: string } | null;
  icon: LucideIcon;
};

export type RoutineRunStatus = 'done' | 'failed' | 'running';

export type RoutineRun = {
  id: string;
  routineId: string;
  status: RoutineRunStatus;
  startedAt: string;
  endedAt: string;
  trace: TraceData[];
};

export type Selection =
  | { kind: 'task'; id: string }
  | { kind: 'routine'; id: string };

export const DEFAULT_SELECTION: Selection = { kind: 'task', id: 'active' };

// `invokeAgent` heartbeats on a 60s ticker, so two missed beats is the point
// where "quiet" stops being normal jitter. Between there and the stall
// threshold the run is usually mid-retry: a step that exceeds the platform's
// function duration is killed and re-entered by the workflow runtime, and the
// heartbeat legitimately goes quiet for several minutes across that gap — so
// this band is reported as a fact, not as a failure.
const HEARTBEAT_FRESH_MS = 120_000;
// Mirrors DEFAULT_REAPER_STALENESS_SECONDS in src/lib/workforce/dispatcher.ts,
// which is when the server would reap this row as stuck. Deliberately copied
// rather than imported: that module pulls in repositories and the DB client,
// and dragging server-only code into a client component breaks the build.
const HEARTBEAT_STALLED_MS = 1_800_000;

export type Liveness = {
  tone: string;
  dot: string;
  label: string;
  title: string;
};

export function describeLiveness(
  lastHeartbeatAt: string | null,
  now: number,
): Liveness | null {
  if (!lastHeartbeatAt) return null;
  const beatAt = new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(beatAt)) return null;

  const quietMs = Math.max(0, now - beatAt);
  const quiet = fmtDuration(quietMs);

  if (quietMs <= HEARTBEAT_FRESH_MS) {
    return {
      tone: 'text-emerald-600',
      dot: 'bg-emerald-500 animate-pulse',
      label: `Active · ${quiet} ago`,
      title: `The agent checked in ${quiet} ago. It heartbeats every 60s while working.`,
    };
  }
  if (quietMs < HEARTBEAT_STALLED_MS) {
    return {
      tone: 'text-amber-600',
      dot: 'bg-amber-500',
      label: `Quiet for ${quiet}`,
      title:
        `No check-in for ${quiet} (expected every 60s). This is normal for a ` +
        `few minutes while a killed step is retried, but the agent is not ` +
        `doing work right now.`,
    };
  }
  return {
    tone: 'text-rose-600',
    dot: 'bg-rose-500',
    label: `Stalled for ${quiet}`,
    title:
      `No check-in for ${quiet}. The run is past the point where the server ` +
      `treats it as stuck — it is very unlikely to resume on its own.`,
  };
}

export function fmtDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function useVisibleInterval(
  fn: () => void,
  ms: number,
  enabled: boolean,
): void {
  const savedFn = useRef(fn);
  savedFn.current = fn;

  useEffect(() => {
    if (!enabled) return;

    const onTick = () => {
      if (document.visibilityState === 'hidden') return;
      savedFn.current();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        savedFn.current();
      }
    };

    const intervalId = window.setInterval(onTick, ms);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [ms, enabled]);
}

