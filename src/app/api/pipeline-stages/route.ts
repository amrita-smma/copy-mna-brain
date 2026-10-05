import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { pipelineStageErrorResponse } from './errorResponse';

/** The workspace's pipeline stages in order, deleted ones included (flagged). */
export async function GET() {
  try {
    const db = createDb();
    const { pipelineStageService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await pipelineStageService.list();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return pipelineStageErrorResponse(error, '[GET /api/pipeline-stages]');
  }
}

/** Add a stage: `{ code, name, description?, afterKey }`. */
export async function POST(req: NextRequest) {
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const { code, name, description, afterKey } = body as Record<string, unknown>;
    const db = createDb();
    const { pipelineStageService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await pipelineStageService.create({ code, name, description, afterKey });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return pipelineStageErrorResponse(error, '[POST /api/pipeline-stages]');
  }
}

/**
 * Save several stages' text fields at once: `{ stages: [{ key, code, name,
 * description }] }`. All-or-nothing; returns the stage list.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const { stages } = body as Record<string, unknown>;
    const db = createDb();
    const { pipelineStageService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await pipelineStageService.updateMany(stages);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return pipelineStageErrorResponse(error, '[PATCH /api/pipeline-stages]');
  }
}
