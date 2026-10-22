import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { botErrorResponse, botRequestContext } from '../../../../shared';

type Params = { params: Promise<{ id: string; routineId: string }> };

/** Sends the routine's message now, as the caller, in their chat with the bot. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const ctx = await botRequestContext();
    if ('response' in ctx) return ctx.response;
    const { id, routineId } = await params;
    const { botRoutineService } = createContainer(createDb(), ctx.workspaceId);
    await botRoutineService.runNow(ctx.userId, id, routineId);
    return NextResponse.json({ data: { id: routineId } }, { status: 202 });
  } catch (error: unknown) {
    return botErrorResponse(error, '[POST /api/bots/[id]/routines/[routineId]/run]');
  }
}
