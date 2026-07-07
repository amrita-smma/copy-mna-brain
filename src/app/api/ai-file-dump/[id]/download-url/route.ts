import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const { url, fileName } = await fileService.getSignedDownloadUrl(id);

    return NextResponse.json({ success: true, url, fileName });
  } catch (error) {
    console.error('Get download URL error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to get download URL' },
      { status: 500 },
    );
  }
}
