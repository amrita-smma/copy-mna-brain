import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';

/**
 * Sourcing → Pending Confirmation "Scan now": queue every active company in
 * Pending Confirmation for a fresh match + screen (re-running criteria that
 * already have a result), whatever the auto-scan toggle says. Auto
 * drop/promote still applies afterwards when it is on.
 *
 * POST → 202 `{ data: { queued } }`; the per-minute drain starts the scans.
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
    const queued = await pendingAutoScanService.scanNow();
    return NextResponse.json({ data: { queued } }, { status: 202 });
  } catch (error: unknown) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
