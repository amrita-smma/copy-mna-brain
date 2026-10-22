import { NextRequest, NextResponse } from 'next/server';
import { getActiveWorkspaceId, getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { auth } from '@/auth';
import { RoutinesRepository } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { enqueueAgentRun } from '@/lib/workforce';
import { buildRoutineRunPayload } from '@/lib/routines';
import { createContainer } from '@/lib/services/container';
import { routineErrorResponse } from '../../errorResponse';

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
    const existing = await repo.findWorkforceRoutineById(id);
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

  let routineId = '';
  try {
    const { id } = await params;
    routineId = id;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { routineService } = createContainer(db, workspaceId);
    // Refuses (409) a routine paused for a broken agent binding (MB-560), and
    // resolves the run's agent the same way the fire tick does.
    const { routine, insightName, agentKey } =
      await routineService.prepareManualRun(id);

    const { triggerMeta, input } = buildRoutineRunPayload(routine, {
      insightName,
      agentKey,
      baseTriggerMeta: {
        routine_id: routine.id,
        manual: true,
        fired_at: new Date().toISOString(),
      },
    });

    const { runId, created } = await enqueueAgentRun(db, {
      agentName: routine.agent_name ?? DEFAULT_ROUTINE_AGENT,
      triggerSource: 'api',
      triggerMeta,
      input,
      priority: routine.priority,
      originRoutineId: routine.id,
      triggeredByUserId: userId,
    });

    return NextResponse.json({ runId, created }, { status: 201 });
  } catch (error: unknown) {
    return routineErrorResponse(error, `[POST /api/routines/${routineId}/runs]`);
  }
}
