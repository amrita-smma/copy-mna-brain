import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext } from '../shared';

/** Saves the caller's pinned bots, in order; body `{ bot_ids: string[] }`. Returns the reordered list. */
export async function PUT(req: NextRequest) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    const data = await botService.setPinned(ctx.userId, (body as { bot_ids?: unknown }).bot_ids);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return botErrorResponse(error, '[PUT /api/bots/pins]');
  }
}
