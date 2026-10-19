import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fileService.getStatus(id);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = (error as Error).message || 'Failed to load file';
    const status = /not found/i.test(message) ? 404 : 500;
    if (status === 500) console.error('Get file status error:', error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    await fileService.delete(id);

    return NextResponse.json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete file error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to delete file' },
      { status: 500 },
    );
  }
}
