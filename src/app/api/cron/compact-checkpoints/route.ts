import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Scheduled LangGraph checkpoint compaction (hourly, see vercel.json crons).
 * Keeps each idle Copilot thread's newest checkpoints and deletes the rest;
 * see `CheckpointCompactionService`. Checkpoints are not workspace-scoped, so
 * one pass covers every workspace.
 *
 * Protected by CRON_SECRET; Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET`. When unset, the route is open (local dev only).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const db = createDb();
    // Any workspace id builds the container; the compaction itself is global.
    const { checkpointCompactionService } = createContainer(db, MNA_WORKSPACE_ID);
    const result = await checkpointCompactionService.run();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/compact-checkpoints] failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
