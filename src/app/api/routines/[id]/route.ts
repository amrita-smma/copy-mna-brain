import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { RoutinesRepository } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { computeNextFireAt, normalizeSchedule } from '@/lib/routines';
import type { ScheduleKind } from '@/lib/routines';

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
    prompt: z.string().min(1).optional(),
    schedule_kind: z.enum(['daily', 'weekly', 'monthly', 'cron']).optional(),
    // Kept loose here — z.union would let a weekly payload match dailySpec
    // first and strip `weekdays`. The kind-keyed superRefine below validates
    // the spec against the actual schedule_kind.
    schedule_spec: z.record(z.string(), z.unknown()).optional(),
    timezone: z.string().optional(),
    agent_name: z.string().nullable().optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
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
    const repo = new RoutinesRepository(db);
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

  try {
    const { id } = await params;
    const db = createDb();
    const repo = new RoutinesRepository(db);

    const existing = await repo.findById(id);
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if ((existing as Record<string, unknown>).is_system) {
      return NextResponse.json({ error: 'System routines cannot be modified' }, { status: 403 });
    }

    const patch: Record<string, unknown> = { updated_by: userId };
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.prompt !== undefined) patch.prompt = parsed.data.prompt;
    if (parsed.data.agent_name !== undefined) patch.agent_name = parsed.data.agent_name;
    if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.timezone !== undefined) patch.timezone = parsed.data.timezone;

    // If schedule changes, re-derive the cron expression and reset next_fire_at.
    if (parsed.data.schedule_kind && parsed.data.schedule_spec) {
      const normalized = normalizeSchedule(
        parsed.data.schedule_kind as ScheduleKind,
        parsed.data.schedule_spec,
      );
      patch.schedule_kind = parsed.data.schedule_kind;
      patch.schedule_spec = normalized.scheduleSpec;
      patch.cron_expression = normalized.cronExpression;
      patch.next_fire_at = computeNextFireAt(
        normalized.cronExpression,
        parsed.data.timezone ?? existing.timezone,
        new Date(),
        {
          kind: parsed.data.schedule_kind as ScheduleKind,
          spec: normalized.scheduleSpec,
        },
      );
    } else if (parsed.data.timezone !== undefined) {
      // Timezone-only change still moves the next fire instant. Preserve the
      // existing schedule kind+spec so monthly clamping stays consistent.
      patch.next_fire_at = computeNextFireAt(
        existing.cron_expression,
        parsed.data.timezone,
        new Date(),
        {
          kind: existing.schedule_kind as ScheduleKind,
          spec: existing.schedule_spec as Record<string, unknown>,
        },
      );
    }

    const row = await repo.update(id, patch);
    return NextResponse.json({ item: row });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to update routine';
    return NextResponse.json({ error: message }, { status: 400 });
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
    const repo = new RoutinesRepository(db);
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
