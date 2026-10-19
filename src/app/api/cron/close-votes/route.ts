import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled vote-deadline sweep.
 *
 * - Fires every 5 minutes (configured in vercel.json crons).
 * - Concludes every open voting round whose deadline has passed: ballots still
 *   in draft are auto-submitted (as picked if the voter had chosen, otherwise
 *   INCONCLUSIVE), the round flips to `completed`, and the AI synthesis +
 *   recap emails are queued.
 *
 * Runs across EVERY workspace. Vercel Cron carries no session, so
 * `getActiveWorkspaceId()` would silently fall back to the default workspace
 * and leave every other tenant's rounds open forever — so this enumerates
 * workspaces and sweeps each with its own workspace-scoped container instead.
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
    // Any workspace id resolves the container needed to list workspaces; the
    // per-workspace containers below are what actually do the scoped work.
    const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
    const workspaces = await workspaceService.listWorkspaces();

    let concluded = 0;
    const failedWorkspaces: string[] = [];
    for (const workspace of workspaces) {
      try {
        const { companyVoteService } = createContainer(db, workspace.id);
        const result = await companyVoteService.processDueSessions();
        concluded += result.concluded;
      } catch (err) {
        // One tenant's failure must not stall the sweep for the others.
        failedWorkspaces.push(workspace.id);
        console.error(
          `[cron/close-votes] workspace ${workspace.id} sweep failed:`,
          err,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      workspaces: workspaces.length,
      concluded,
      ...(failedWorkspaces.length ? { failedWorkspaces } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'vote deadline sweep failed';
    console.error('[cron/close-votes] failed:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
