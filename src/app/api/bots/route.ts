import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext } from './shared';

/** The caller's visible bots, in their saved order. */
export async function GET() {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    const data = await botService.list(ctx.userId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return botErrorResponse(error, '[GET /api/bots]');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    const data = await botService.create(ctx.userId, body);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    return botErrorResponse(error, '[POST /api/bots]');
  }
}
