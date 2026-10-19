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
  InvalidPipelineRequiredFieldsError,
  parsePipelineRequiredFieldsInput,
} from '@/lib/pipeline/requiredFields';
import { WorkspaceNotFoundError } from '@/lib/services/workspaceService';

/**
 * Pipeline Settings → Required Fields: which fields a company must have
 * before it can enter the pipeline. A workspace-wide setting any member can change.
 *
 * GET → `{ data: PipelineFieldKey[] }` for the active workspace (every field when
 *       the workspace never configured it).
 * PUT → `{ requiredFields: PipelineFieldKey[] }`; the company name is always kept.
 *       Applies to the next pipeline entry — companies already in the
 *       pipeline are unaffected.
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
    const data = await workspaceService.getPipelineRequiredFields(workspaceId);
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
    const requiredFields = parsePipelineRequiredFieldsInput(await req.json());
    const data = await workspaceService.updatePipelineRequiredFields(workspaceId, requiredFields);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof InvalidPipelineRequiredFieldsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
