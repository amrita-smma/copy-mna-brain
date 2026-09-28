import { NextRequest, NextResponse } from 'next/server';
import { getActiveWorkspaceId, getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { z } from 'zod';
import { auth } from '@/auth';
import { RoutinesRepository } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { routineErrorResponse } from '../errorResponse';

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

const specByKind = {
  daily: dailySpec,
  weekly: weeklySpec,
  monthly: monthlySpec,
  cron: cronSpec,
} as const;

const patchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    prompt: z.string().optional(),
    schedule_kind: z.enum(['daily', 'weekly', 'monthly', 'cron']).optional(),
    // Kept loose here — z.union would let a weekly payload match dailySpec
    // first and strip `weekdays`. The kind-keyed superRefine below validates
    // the spec against the actual schedule_kind.
    schedule_spec: z.record(z.string(), z.unknown()).optional(),
    timezone: z.string().optional(),
    agent_name: z.string().nullable().optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
    insight_id: z.string().uuid().nullable().optional(),
  })
  .refine(
    (v) => (v.schedule_kind === undefined) === (v.schedule_spec === undefined),
    { message: 'schedule_kind and schedule_spec must be updated together' },
  )
  .superRefine((v, ctx) => {
    if (!v.schedule_kind || !v.schedule_spec) return;
    const result = specByKind[v.schedule_kind].safeParse(v.schedule_spec);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: ['schedule_spec', ...issue.path],
        });
      }
    }
  });

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
    const item = await repo.findById(id);
    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const runCount = await repo.countRuns(id);
    return NextResponse.json({ item, runCount });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to load routine';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid patch', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let routineId = '';
  try {
    const { id } = await params;
    routineId = id;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { routineService } = createContainer(db, workspaceId);

    const row = await routineService.update(id, parsed.data, userId);
    return NextResponse.json({ item: row });
  } catch (error: unknown) {
    return routineErrorResponse(error, `[PATCH /api/routines/${routineId}]`);
  }
}

export async function DELETE(
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
    if ((existing as Record<string, unknown>).is_system) {
      return NextResponse.json({ error: 'System routines cannot be archived' }, { status: 403 });
    }
    const row = await repo.archive(id);
    return NextResponse.json({ item: row });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to archive routine';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
