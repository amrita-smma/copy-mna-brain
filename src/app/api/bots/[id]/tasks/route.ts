import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext } from '../../shared';

type Params = { params: Promise<{ id: string }> };

/**
 * The bot's task log, newest first: the caller's own tasks plus every routine
 * run. `?before=<cursor>&limit=30` pages back.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id } = await params;
    const search = req.nextUrl.searchParams;
    const limit = Number(search.get('limit'));
    const { botTaskLogService } = createContainer(createDb(), ctx.workspaceId);
    const data = await botTaskLogService.list(ctx.userId, id, {
      before: search.get('before') ?? undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return botErrorResponse(error, '[GET /api/bots/[id]/tasks]');
  }
}
