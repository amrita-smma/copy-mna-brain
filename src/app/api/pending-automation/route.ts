import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import {
  getActiveWorkspaceId,
  getActiveWorkspaceIdOrThrow,
  NoActiveWorkspaceError,
} from '@/lib/workspace';
import {
  InvalidPendingAutomationError,
  parsePendingAutomationInput,
} from '@/lib/sourcing/pendingAutomation';
import { WorkspaceNotFoundError } from '@/lib/services/workspaceService';

/**
 * Sourcing → Pending Confirmation automation toggles (auto-scan, auto
 * promote, auto drop). A workspace-wide setting any member can change.
 *
 * GET → the current toggles for the active workspace.
 * PUT → save them. Auto-scan only applies to companies that enter Pending
 *       Confirmation from then on; the companies already waiting are left
 *       alone (Scan now covers them).
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { workspaceService } = createContainer(db, workspaceId);
    const data = await workspaceService.getPendingAutomation(workspaceId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    // A write resolves the workspace fail-closed — the NO_ACTIVE_WORKSPACE_ID
    // sentinel must never reach an UPDATE's WHERE clause.
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const { workspaceService } = createContainer(db, workspaceId);
    const input = parsePendingAutomationInput(await req.json());
    const data = await workspaceService.updatePendingAutomation(workspaceId, input);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof InvalidPendingAutomationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
