import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { pipelineStageErrorResponse } from '../errorResponse';

/** Update a stage's `{ code?, name?, description? }`. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await params;
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const { code, name, description } = body as Record<string, unknown>;
    const db = createDb();
    const { pipelineStageService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await pipelineStageService.update(key, { code, name, description });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return pipelineStageErrorResponse(error, '[PATCH /api/pipeline-stages/[key]]');
  }
}

/**
 * Delete a stage. `?moveTo=<key>` names the stage its active companies move
 * to — required when it has any.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await params;
    const moveTo = req.nextUrl.searchParams.get('moveTo') || undefined;
    const db = createDb();
    const { pipelineStageService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await pipelineStageService.delete(key, moveTo);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return pipelineStageErrorResponse(error, '[DELETE /api/pipeline-stages/[key]]');
  }
}
