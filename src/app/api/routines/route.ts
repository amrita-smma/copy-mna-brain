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

// Discriminated by schedule_kind so the right spec schema is enforced.
// A plain z.union would let a weekly payload match dailySpec first and silently
// strip `weekdays`, which then crashes normalizeSchedule downstream.
const baseFields = {
  title: z.string().min(1).max(200),
  prompt: z.string().min(1),
  timezone: z.string().default('UTC'),
  agent_name: z.string().optional().nullable(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
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
    const repo = new RoutinesRepository(db);
    const items = await repo.list();
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
    const normalized = normalizeSchedule(
      parsed.data.schedule_kind as ScheduleKind,
      parsed.data.schedule_spec,
    );
    const nextFireAt = computeNextFireAt(
      normalized.cronExpression,
      parsed.data.timezone,
      new Date(),
      {
        kind: parsed.data.schedule_kind as ScheduleKind,
        spec: normalized.scheduleSpec,
      },
    );

    const db = createDb();
    const repo = new RoutinesRepository(db);
    const row = await repo.create({
      title: parsed.data.title,
      prompt: parsed.data.prompt,
      schedule_kind: parsed.data.schedule_kind,
      schedule_spec: normalized.scheduleSpec,
      cron_expression: normalized.cronExpression,
      timezone: parsed.data.timezone,
      agent_name: parsed.data.agent_name ?? null,
      priority: parsed.data.priority ?? 0,
      enabled: parsed.data.enabled ?? true,
      next_fire_at: nextFireAt,
      created_by: userId,
    });

    return NextResponse.json({ item: row }, { status: 201 });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to create routine';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
