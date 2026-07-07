import { NextRequest, NextResponse } from 'next/server';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { auth } from '@/auth';
import { RoutinesRepository } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { enqueueAgentRun } from '@/lib/workforce';

const DEFAULT_ROUTINE_AGENT = 'analysis';

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
    const repo = new RoutinesRepository(db, await getActiveWorkspaceId());
    const existing = await repo.findById(id);
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const items = await repo.listRuns(id);
    return NextResponse.json({ items });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to list routine runs';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Manually enqueue a workforce run for this routine — the "Add to current
 * queue" button. Bypasses the cron schedule: it does NOT update last_fired_at
 * or next_fire_at on the routine, so the next scheduled fire still happens
 * on time.
 *
 * Each call creates a new run (no idempotency key); clicking the button N
 * times queues N runs.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  try {
    const { id } = await params;
    const db = createDb();
    const repo = new RoutinesRepository(db, await getActiveWorkspaceId());
    const routine = await repo.findById(id);
    if (!routine) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { runId, created } = await enqueueAgentRun(db, {
      agentName: routine.agent_name ?? DEFAULT_ROUTINE_AGENT,
      triggerSource: 'api',
      triggerMeta: {
        routine_id: routine.id,
        manual: true,
        fired_at: new Date().toISOString(),
      },
      input: {
        title: routine.title,
        instruction: routine.prompt,
        prompt: routine.prompt,
      },
      priority: routine.priority,
      originRoutineId: routine.id,
      triggeredByUserId: userId,
    });

    return NextResponse.json({ runId, created }, { status: 201 });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to enqueue routine run';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
