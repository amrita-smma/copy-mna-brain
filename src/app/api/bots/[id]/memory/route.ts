import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext, readObjectBody } from '../../shared';

type Params = { params: Promise<{ id: string }> };

/** What the bot remembers about the caller: their notes on it. */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const db = createDb();
    const { botMemoryService } = createContainer(db, ctx.workspaceId);
    const notes = await botMemoryService.list(ctx.userId, id);
    return NextResponse.json({ data: { bot_id: id, notes } });
  } catch (error: unknown) {
    return botErrorResponse(error, '[GET /api/bots/[id]/memory]');
  }
}

/** Replace the caller's notes on the bot with `{ notes: string[] }` (the Memory tab). */
export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const body = await readObjectBody(req);
    if (!body) return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    const db = createDb();
    const { botMemoryService } = createContainer(db, ctx.workspaceId);
    const notes = await botMemoryService.replace(ctx.userId, id, body.notes);
    return NextResponse.json({ data: { bot_id: id, notes } });
  } catch (error: unknown) {
    return botErrorResponse(error, '[PUT /api/bots/[id]/memory]');
  }
}
