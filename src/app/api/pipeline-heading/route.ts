import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import {
  getActiveWorkspaceId,
  getActiveWorkspaceIdOrThrow,
  NoActiveWorkspaceError,
} from '@/lib/workspace';
import { InvalidPipelineHeadingError, parsePipelineHeadingInput } from '@/lib/pipeline/heading';
import { WorkspaceNotFoundError } from '@/lib/services/workspaceService';

/**
 * The Deal Pipeline page heading (title + subtitle). A workspace-wide setting,
 * not a per-user preference: any member renaming it renames it for everyone,
 * same as the shared table layouts next door.
 *
 * GET → the resolved heading for the active workspace (defaults when unset).
 * PUT → save it; a blank field clears back to the product default.
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
    const data = await workspaceService.getPipelineHeading(workspaceId);
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
    const input = parsePipelineHeadingInput(await req.json());
    const data = await workspaceService.updatePipelineHeading(workspaceId, input);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof InvalidPipelineHeadingError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
