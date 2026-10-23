import { NextResponse, type NextRequest } from 'next/server';
import { createDb, type DbClient } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

/**
 * The 401 for a cron request without `Authorization: Bearer $CRON_SECRET`
 * (what Vercel Cron sends), or null to go on. With CRON_SECRET unset the route
 * is open (local dev only).
 */
export function cronUnauthorized(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') === `Bearer ${secret}`) return null;
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Runs `fn` for every live workspace, one after another. A cron carries no
 * session, so this lists the workspaces itself and `fn` builds its own
 * workspace-scoped container from `db`. Each workspace runs in its own
 * try/catch, so one tenant's failure is logged and recorded in
 * `failedWorkspaces` without stalling the others. Throws only when the
 * workspaces cannot be listed.
 */
export async function sweepWorkspaces(
  tag: string,
  fn: (workspaceId: string, db: DbClient) => Promise<void>,
): Promise<{ workspaces: number; failedWorkspaces: string[] }> {
  const db = createDb();
  const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
  const workspaces = await workspaceService.listWorkspaces();
  const failedWorkspaces: string[] = [];
  for (const workspace of workspaces) {
    try {
      await fn(workspace.id, db);
    } catch (err) {
      failedWorkspaces.push(workspace.id);
      console.error(`[${tag}] workspace ${workspace.id} failed:`, err);
    }
  }
  return { workspaces: workspaces.length, failedWorkspaces };
}
