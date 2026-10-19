import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import {
  getActiveWorkspaceId,
  getActiveWorkspaceIdOrThrow,
  NoActiveWorkspaceError,
} from '@/lib/workspace';
import {
  InvalidTableIdError,
  InvalidTableLayoutError,
} from '@/lib/services/tableLayoutService';

/**
 * Workspace-wide column layouts for the managed data tables. These are shared
 * settings, not per-user preferences: any member reordering / hiding / grouping
 * columns saves it for the whole workspace.
 *
 * GET  → every saved layout for the active workspace (one call hydrates all
 *        tables, avoiding a request per table).
 * PUT  → save one table's layout.
 * DELETE ?tableId=… → drop one table's layout back to the declared defaults.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { tableLayoutService } = createContainer(db, await getActiveWorkspaceId());
    const data = await tableLayoutService.listLayouts();
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
    // Writes resolve the workspace fail-closed: the NO_ACTIVE_WORKSPACE_ID
    // sentinel must never be stamped onto an inserted row.
    const { tableLayoutService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const { tableId, layout } = await req.json();
    const data = await tableLayoutService.saveLayout(tableId, layout, session.user.id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof InvalidTableIdError || error instanceof InvalidTableLayoutError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { tableLayoutService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const tableId = req.nextUrl.searchParams.get('tableId') ?? '';
    await tableLayoutService.resetLayout(tableId);
    return NextResponse.json({ data: { tableId } });
  } catch (error: unknown) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof InvalidTableIdError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
