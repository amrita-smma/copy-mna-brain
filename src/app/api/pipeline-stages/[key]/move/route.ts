import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { pipelineStageErrorResponse } from '../../errorResponse';

/** Move a stage one position: `{ direction: 'up' | 'down' }`. Returns the reordered stages. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await params;
    const body: unknown = await req.json();
    const direction = (body as { direction?: unknown } | null)?.direction;
    if (direction !== 'up' && direction !== 'down') {
      return NextResponse.json({ error: "direction must be 'up' or 'down'" }, { status: 400 });
    }
    const db = createDb();
    const { pipelineStageService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await pipelineStageService.move(key, direction);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return pipelineStageErrorResponse(error, '[POST /api/pipeline-stages/[key]/move]');
  }
}
