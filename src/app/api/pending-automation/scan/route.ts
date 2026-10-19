import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';

/**
 * Sourcing → Pending Confirmation "Scan now": queue an AI screening task on
 * the AI Workforce for every active company in Pending Confirmation — a fresh
 * match + screen, re-running criteria that already have a result — whatever
 * the auto-scan toggle says. Auto promote / auto drop still apply afterwards
 * when they are on. Companies already queued or scanning are skipped.
 *
 * POST → 202 `{ data: { queued, alreadyQueued } }`.
 */
export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const { pendingAutoScanService } = createContainer(db, workspaceId);
    const data = await pendingAutoScanService.scanNow(session.user.id);
    return NextResponse.json({ data }, { status: 202 });
  } catch (error: unknown) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
