import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { asyncJobId } from '@/lib/services/fileService';
import { getActiveWorkspaceId } from '@/lib/workspace';

export const maxDuration = 600;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const result = await fileService.reprocess(id);

    const isAsync = Boolean(asyncJobId(result));
    return NextResponse.json({ success: true, data: result }, { status: isAsync ? 202 : 200 });
  } catch (error) {
    console.error('Reprocess file error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to reprocess file' },
      { status: 500 },
    );
  }
}
