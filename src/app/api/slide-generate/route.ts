import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import type { SlideGenerationPayload } from '@/lib/jobs/handlers/slideGeneration';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SlideGenerationPayload;
    if (!body.instruction) {
      return NextResponse.json(
        { error: 'Missing required field: instruction' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { slideService } = createContainer(db, await getActiveWorkspaceId());
    const { jobId } = await slideService.generateDispatch(body);

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    console.error('POST slide-generate error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
