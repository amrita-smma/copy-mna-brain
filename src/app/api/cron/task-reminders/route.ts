import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled personal-task reminder sweep.
 *
 * - Fires every minute (configured in vercel.json crons).
 * - Emails the owner of every open task whose `remind_at` has passed, once,
 *   via the `send-email` queue, then stamps `reminder_sent_at`.
 *
 * Runs across EVERY workspace for the same reason as `close-votes`: Vercel
 * Cron carries no session, so it enumerates workspaces and sweeps each with
 * its own workspace-scoped container.
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
    const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
    const workspaces = await workspaceService.listWorkspaces();

    let notified = 0;
    const failedWorkspaces: string[] = [];
    for (const workspace of workspaces) {
      try {
        const { userTaskService } = createContainer(db, workspace.id);
        const result = await userTaskService.processDueReminders();
        notified += result.notified;
      } catch (err) {
        // One tenant's failure must not stall the sweep for the others.
        failedWorkspaces.push(workspace.id);
        console.error(`[cron/task-reminders] workspace ${workspace.id} sweep failed:`, err);
      }
    }

    return NextResponse.json({
      ok: true,
      workspaces: workspaces.length,
      notified,
      ...(failedWorkspaces.length ? { failedWorkspaces } : {}),
    });
  } catch (err) {
    console.error('[cron/task-reminders] failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
