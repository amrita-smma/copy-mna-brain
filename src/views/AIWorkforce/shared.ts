import type { LucideIcon } from 'lucide-react';

export type AvatarTone = 'amber' | 'indigo' | 'aqua' | 'rose' | 'slate' | 'violet';

export const avatarToneClass: Record<AvatarTone, string> = {
  amber: 'bg-gradient-to-br from-amber-400 to-amber-600 text-white',
  indigo: 'bg-gradient-to-br from-violet-500 to-indigo-600 text-white',
  aqua: 'bg-gradient-to-br from-emerald-400 to-teal-600 text-white',
  rose: 'bg-gradient-to-br from-pink-400 to-rose-600 text-white',
  slate: 'bg-gradient-to-br from-slate-500 to-slate-700 text-white',
  violet: 'bg-violet-100 text-violet-700',
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

export type InterventionData =
  | {
      state: 'waiting';
      question: string;
      proposal?: string;
      // Identifies the tool call being gated. Required for the decision
      // endpoint to know what to resume.
      tool_call_id?: string;
      tool_name?: string;
    }
  | {
      state: 'resolved';
      question: string;
      resolution: {
        actor: string;
        actorInitials: string;
        avatarTone: AvatarTone;
        decision: 'approved' | 'modified';
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
  toolCalls?: ToolCall[];
  // Summarises the step's outcomes (e.g. "5 matches", "1 eliminated") for
  // the meta row. Empty/undefined for steps with no resolved tool calls.
  outcomeChips?: TraceOutcomeChip[];
  // Snapshot of an in-flight iteration the agent reported via the
  // `report_progress` tool. Rendered as the "Live · partial output" block.
  liveRows?: LiveRow[];
  intervention?: InterventionData;
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
