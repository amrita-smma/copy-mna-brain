import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext } from '../shared';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    const data = await botService.get(ctx.userId, id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return botErrorResponse(error, '[GET /api/bots/[id]]');
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    const data = await botService.update(ctx.userId, id, body);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return botErrorResponse(error, '[PATCH /api/bots/[id]]');
  }
}

/** Archives the bot (soft delete). */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    await botService.archive(ctx.userId, id);
    return NextResponse.json({ data: { id } });
  } catch (error: unknown) {
    return botErrorResponse(error, '[DELETE /api/bots/[id]]');
  }
}
