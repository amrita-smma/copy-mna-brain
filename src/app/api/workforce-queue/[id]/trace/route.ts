import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { UserRepository } from '@/lib/repositories';
import { getWorkforceAgentGraph } from '@/lib/agents/analysis';
import { buildTrace, type TraceActor } from '@/lib/workforce/traceMapper';
import type { AvatarTone } from '@/views/AIWorkforce/shared';
import type { HumanDecision, PendingIntervention } from '@/lib/db/schema';

const TONE_PALETTE: AvatarTone[] = [
  'amber',
  'indigo',
  'aqua',
  'rose',
  'slate',
  'violet',
];

function toneForId(id: string): AvatarTone {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TONE_PALETTE[h % TONE_PALETTE.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { aiWorkforceService, notificationService } = createContainer(db, workspaceId);
    const item = await aiWorkforceService.findById(id);
    // findById is unscoped (shared with system-internal callers) — enforce
    // workspace ownership here, at the user-facing edge. 404 rather than 403
    // so a cross-workspace id doesn't reveal that the task exists at all.
    if (!item || item.workspace_id !== workspaceId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const notifications = await notificationService.list(id);

    const humanDecisions = (item.human_decisions as HumanDecision[] | null) ?? [];
    const pending = (item.pending_intervention ?? null) as PendingIntervention | null;
    const askedUserId = pending?.asked_user_id ?? null;

    // The creator can always decide; so can the person the intervention was
    // addressed to (e.g. the insight owner on a scheduled refresh run, which
    // has no creator). Mirrors the decision route's check.
    const canDecide =
      item.triggered_by_user_id === session.user.id ||
      (askedUserId !== null && askedUserId === session.user.id);

    // One lookup for every user the trace names: the creator (default actor),
    // the person asked, and whoever made each recorded decision.
    const userIds = [
      ...new Set(
        [
          item.triggered_by_user_id,
          askedUserId,
          ...humanDecisions.map((d) => d.decided_by_user_id),
        ].filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    ];
    const users = await new UserRepository(db).findByIds(userIds);
    const actorsById: Record<string, TraceActor> = {};
    for (const user of users) {
      actorsById[user.id] = {
        id: user.id,
        name: user.name,
        initials: initialsOf(user.name),
        avatarTone: toneForId(user.id),
      };
    }

    const actor: TraceActor =
      (item.triggered_by_user_id && actorsById[item.triggered_by_user_id]) || {
        id: item.triggered_by_user_id ?? 'system',
        name: 'System',
        initials: 'SY',
        avatarTone: toneForId(item.triggered_by_user_id ?? 'system'),
      };
    const waitingFor = askedUserId ? actorsById[askedUserId]?.name : undefined;

    // No checkpoint exists until the dispatcher claims the row, so skip the
    // checkpoint read for pending tasks.
    if (item.status === 'pending') {
      return NextResponse.json({
        steps: [],
        canDecide,
        status: item.status,
        actor,
        notifications,
      });
    }

    const graph = await getWorkforceAgentGraph();
    if (!graph) {
      return NextResponse.json(
        { error: 'workforce agent graph unavailable' },
        { status: 503 },
      );
    }

    const { messages, pendingWrites } = await graph.getTrace(item.id);
    const messageTimestamps = await aiWorkforceService.getMessageTimestamps(item.id, messages);
    const TERMINAL: Array<typeof item.status> = [
      'succeeded',
      'failed',
      'rejected',
      'timed_out',
    ];
    const isTerminal = TERMINAL.includes(item.status);
    // User-cancelled rows still live under status='failed' (see
    // AiWorkforceQueueRepository.cancelById). Detect via error.code so the
    // mapper can render trailing plan entries as 'skipped' instead of
    // suppressing them — gives the user visibility into what they cut off.
    const errorPayload =
      item.error && typeof item.error === 'object'
        ? (item.error as Record<string, unknown>)
        : null;
    const isCancelled =
      isTerminal && errorPayload?.code === 'cancelled_by_user';
    const steps = buildTrace({
      messages,
      pendingWrites,
      humanDecisions,
      actor,
      startedAt: item.started_at,
      terminal: isTerminal,
      cancelled: isCancelled,
      messageTimestamps,
      waitingFor,
      deciders: actorsById,
    });

    return NextResponse.json({
      steps,
      canDecide,
      status: item.status,
      actor,
      notifications,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load workforce task trace';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
