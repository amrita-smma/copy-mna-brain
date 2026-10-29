import { NextRequest, NextResponse } from 'next/server';
import { getActiveWorkspaceId, getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { z } from 'zod';
import { auth } from '@/auth';
import { RoutinesRepository } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { routineErrorResponse } from './errorResponse';

const dailySpec = z.object({ time: z.string() });
const weeklySpec = z.object({
  time: z.string(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
});
const monthlySpec = z.object({
  time: z.string(),
  day: z.number().int().min(1).max(31),
});
const cronSpec = z.object({ expression: z.string() });

// Discriminated by schedule_kind so the right spec schema is enforced.
// A plain z.union would let a weekly payload match dailySpec first and silently
// strip `weekdays`, which then crashes normalizeSchedule downstream.
const baseFields = {
  title: z.string().min(1).max(200),
  prompt: z.string(),
  timezone: z.string().default('UTC'),
  agent_name: z.string().optional().nullable(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  insight_id: z.string().uuid().nullable().optional(),
};

const createSchema = z.discriminatedUnion('schedule_kind', [
  z.object({ ...baseFields, schedule_kind: z.literal('daily'), schedule_spec: dailySpec }),
  z.object({ ...baseFields, schedule_kind: z.literal('weekly'), schedule_spec: weeklySpec }),
  z.object({ ...baseFields, schedule_kind: z.literal('monthly'), schedule_spec: monthlySpec }),
  z.object({ ...baseFields, schedule_kind: z.literal('cron'), schedule_spec: cronSpec }),
]);

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const repo = new RoutinesRepository(db, workspaceId);
    const { aiWorkforceService } = createContainer(db, workspaceId);
    const routines = await repo.list();
    // Every run each routine has spawned, for the routine canvas's "N runs
    // total" — one grouped count, not the rail's (paged) run list.
    const runCounts = await aiWorkforceService.countRunsByRoutineIds(
      routines.map((r) => r.id),
    );
    const items = routines.map((r) => ({ ...r, run_count: runCounts.get(r.id) ?? 0 }));
    return NextResponse.json({ items });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to list routines';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid routine payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { routineService } = createContainer(db, workspaceId);

    const row = await routineService.create(
      {
        title: parsed.data.title,
        prompt: parsed.data.prompt,
        schedule_kind: parsed.data.schedule_kind,
        schedule_spec: parsed.data.schedule_spec,
        timezone: parsed.data.timezone,
        agent_name: parsed.data.agent_name,
        priority: parsed.data.priority,
        enabled: parsed.data.enabled,
        insight_id: parsed.data.insight_id,
      },
      userId,
    );
    return NextResponse.json({ item: row }, { status: 201 });
  } catch (error: unknown) {
    return routineErrorResponse(error, '[POST /api/routines]');
  }
}
