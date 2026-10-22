import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext } from '../../shared';

/** Marks the caller's thread with the bot read, clearing its unread dot. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    await botService.markRead(ctx.userId, id);
    return NextResponse.json({ data: { id } });
  } catch (error: unknown) {
    return botErrorResponse(error, '[POST /api/bots/[id]/read]');
  }
}

/** Marks the caller's thread with the bot unread again, restoring its dot. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    await botService.markUnread(ctx.userId, id);
    return NextResponse.json({ data: { id } });
  } catch (error: unknown) {
    return botErrorResponse(error, '[DELETE /api/bots/[id]/read]');
  }
}
