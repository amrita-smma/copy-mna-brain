import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import type { BotRoutinePatch } from '@/lib/bots/routineTypes';
import { botErrorResponse, botRequestContext, readObjectBody } from '../../../shared';

type Params = { params: Promise<{ id: string; routineId: string }> };

/** Body: any of `{ title, prompt, schedule_kind, schedule_spec, timezone, enabled }`. */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id, routineId } = await params;
    const body = await readObjectBody(req);
    if (!body) return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    const { botRoutineService } = createContainer(createDb(), ctx.workspaceId);
    const data = await botRoutineService.update(ctx.userId, id, routineId, body as BotRoutinePatch);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return botErrorResponse(error, '[PATCH /api/bots/[id]/routines/[routineId]]');
  }
}

/** Archives the routine. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id, routineId } = await params;
    const { botRoutineService } = createContainer(createDb(), ctx.workspaceId);
    await botRoutineService.archive(ctx.userId, id, routineId);
    return NextResponse.json({ data: { id: routineId } });
  } catch (error: unknown) {
    return botErrorResponse(error, '[DELETE /api/bots/[id]/routines/[routineId]]');
  }
}
