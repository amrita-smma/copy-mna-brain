import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext } from '../../shared';

/** Opens (creating on first use) the caller's one permanent thread with the bot. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const db = createDb();
    const { botService } = createContainer(db, ctx.workspaceId);
    const { chat } = await botService.openThread(ctx.userId, id);
    return NextResponse.json({ data: { chatId: chat.id } });
  } catch (error: unknown) {
    return botErrorResponse(error, '[POST /api/bots/[id]/thread]');
  }
}
