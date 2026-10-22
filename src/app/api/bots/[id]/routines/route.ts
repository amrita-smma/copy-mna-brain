import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext, readObjectBody } from '../../shared';

type Params = { params: Promise<{ id: string }> };

/** The bot's routines: its owner's for a private bot, everyone's for a shared one. */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const { botRoutineService } = createContainer(createDb(), ctx.workspaceId);
    const data = await botRoutineService.list(ctx.userId, id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return botErrorResponse(error, '[GET /api/bots/[id]/routines]');
  }
}

/** Body: `{ title, prompt, schedule_kind, schedule_spec, timezone }`. Runs as the caller. */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const body = await readObjectBody(req);
    if (!body) return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    const { botRoutineService } = createContainer(createDb(), ctx.workspaceId);
    const data = await botRoutineService.create(ctx.userId, id, body);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    return botErrorResponse(error, '[POST /api/bots/[id]/routines]');
  }
}
