import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { users } from '@/lib/db/schema';
import { getWorkforceAgentGraph } from '@/lib/agents/analysis';
import { buildTrace, type TraceActor } from '@/lib/workforce/traceMapper';
import type { AvatarTone } from '@/views/AIWorkforce/shared';
import type { HumanDecision } from '@/lib/db/schema';

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
    const { aiWorkforceService } = createContainer(db);
    const item = await aiWorkforceService.findById(id);
    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const canDecide = item.triggered_by_user_id === session.user.id;

    // Resolve the creator-actor for resolved-intervention rendering. Only
    // the creator can decide, so this is also the only actor we'll ever
    // need to label decisions with.
    let actor: TraceActor = {
      id: item.triggered_by_user_id ?? 'system',
      name: 'System',
      initials: 'SY',
      avatarTone: toneForId(item.triggered_by_user_id ?? 'system'),
    };
    if (item.triggered_by_user_id) {
      const [user] = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, item.triggered_by_user_id))
        .limit(1);
      if (user) {
        actor = {
          id: user.id,
          name: user.name,
          initials: initialsOf(user.name),
          avatarTone: toneForId(user.id),
        };
      }
    }

    // No checkpoint exists until the dispatcher claims the row, so skip the
    // checkpoint read for pending tasks.
    if (item.status === 'pending') {
      return NextResponse.json({
        steps: [],
        canDecide,
        status: item.status,
        actor,
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
    const humanDecisions = (item.human_decisions as HumanDecision[] | null) ?? [];

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
    });

    return NextResponse.json({ steps, canDecide, status: item.status, actor });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load workforce task trace';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
