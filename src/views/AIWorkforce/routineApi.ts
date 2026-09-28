import { formatDistanceToNow } from 'date-fns';
import { LayoutGrid, RefreshCw, Search, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Direct import, never the `@/lib/routines` barrel: that reaches the cron tick
// and server-only code, and this module ships in the client bundle.
import { describeRoutinePause, isRoutinePausedReason } from '@/lib/routines/pauseReason';

import type { Routine } from './shared';

/**
 * Shape returned by `/api/routines`. Matches the `routines` table row plus
 * the UI doesn't care about every column — keep this list narrow so adding
 * server columns doesn't break the client.
 */
export interface ApiRoutine {
  id: string;
  title: string;
  prompt: string;
  schedule_kind: 'daily' | 'weekly' | 'monthly' | 'cron';
  schedule_spec: Record<string, unknown>;
  cron_expression: string;
  timezone: string;
  agent_name: string | null;
  priority: number;
  enabled: boolean;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  insight_id: string | null;
  insight_name?: string | null;
  /** The refreshed insight's current binding (list endpoint only). */
  insight_agent_key?: string | null;
  /**
   * Why the system paused the routine (MB-560); null for a running routine and
   * for a manual pause.
   */
  paused_reason?: string | null;
  paused_at?: string | null;
}

const ICON_PALETTE: LucideIcon[] = [Search, RefreshCw, Zap, LayoutGrid];

function iconForId(id: string): LucideIcon {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ICON_PALETTE[h % ICON_PALETTE.length];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function summarizeKind(routine: ApiRoutine): {
  short: string;
  detailed: string;
} {
  const spec = routine.schedule_spec ?? {};
  const tz = routine.timezone;
  switch (routine.schedule_kind) {
    case 'daily': {
      const time = (spec as { time?: string }).time ?? '00:00';
      return { short: 'Daily', detailed: `Daily at ${time} ${tz}` };
    }
    case 'weekly': {
      const time = (spec as { time?: string }).time ?? '00:00';
      const wd = ((spec as { weekdays?: number[] }).weekdays ?? []).map(
        (d) => DAY_NAMES[d] ?? String(d),
      );
      return {
        short: `Weekly · ${wd.join(',')}`,
        detailed: `${wd.length === 1 ? `${wd[0]}s` : wd.join('/')} at ${time} ${tz}`,
      };
    }
    case 'monthly': {
      const time = (spec as { time?: string }).time ?? '00:00';
      const day = (spec as { day?: number }).day ?? 1;
      return {
        short: `Monthly · day ${day}`,
        detailed: `Monthly on day ${day} at ${time} ${tz}`,
      };
    }
    case 'cron':
      return {
        short: 'Custom',
        detailed: `${routine.cron_expression} (${tz})`,
      };
  }
}

function summarizeLastRun(lastFiredAt: string | null): string {
  if (!lastFiredAt) return 'never run';
  return `last ran ${formatDistanceToNow(new Date(lastFiredAt), { addSuffix: false })} ago`;
}

function summarizeNextRun(nextFireAt: string | null): string {
  if (!nextFireAt) return 'paused';
  const date = new Date(nextFireAt);
  if (date.getTime() <= Date.now()) return 'due now';
  return `in ${formatDistanceToNow(date)}`;
}

/**
 * Convert the raw API routine row to the UI `Routine` shape. The UI fields
 * `scheduleSummary` and `scheduleDetailed` are derived from schedule_kind +
 * schedule_spec so callers don't have to know about the wire shape.
 */
export function apiRoutineToUi(
  row: ApiRoutine,
  opts: {
    runCount?: number;
    currentUserId?: string | null;
    /**
     * The insight's binding, for naming the agent in a paused notice when the
     * row doesn't carry `insight_agent_key` (the per-insight endpoint).
     */
    insightAgentKey?: string | null;
  } = {},
): Routine {
  const summary = summarizeKind(row);
  const createdByLabel =
    opts.currentUserId && row.created_by === opts.currentUserId
      ? 'You'
      : 'Teammate';

  const pausedReason = isRoutinePausedReason(row.paused_reason) ? row.paused_reason : null;
  const pausedNotice = describeRoutinePause(
    pausedReason,
    row.insight_agent_key ?? opts.insightAgentKey ?? null,
  );

  return {
    id: row.id,
    name: row.insight_name ?? row.title,
    scheduleSummary: `${summary.short} · ${summarizeLastRun(row.last_fired_at)}`,
    scheduleDetailed: summary.detailed,
    nextRun: summarizeNextRun(row.enabled ? row.next_fire_at : null),
    createdBy: createdByLabel,
    createdAgo: `${formatDistanceToNow(new Date(row.created_at))} ago`,
    instruction: row.prompt,
    runCount: opts.runCount ?? 0,
    isFiring: false,
    enabled: row.enabled,
    pausedReason,
    pausedNotice,
    insight: row.insight_id
      ? { id: row.insight_id, name: row.insight_name ?? row.title }
      : null,
    icon: iconForId(row.id),
  };
}
