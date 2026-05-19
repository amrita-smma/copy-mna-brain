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
  running?: boolean;
  output?: {
    label: string;
    rows: ToolCallRow[];
  };
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
  title: string;
  description: string;
  timestamp: string;
  toolCalls?: ToolCall[];
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
