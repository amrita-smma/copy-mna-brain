import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { InvalidOccurredAtError } from '@/lib/timeline/occurredAt';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dealId, key, fileName, fileSize, mimeType, stage, featured, createdAt } = body;

    if (!dealId || !key || !fileName) {
      return NextResponse.json(
        { error: 'dealId, key, and fileName are required' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { dealDocumentService } = createContainer(db, await getActiveWorkspaceId());
    await dealDocumentService.register({
      deal_id: dealId,
      file_path: key,
      file_name: fileName,
      file_size: fileSize ?? null,
      mime_type: mimeType ?? null,
      stage: stage ?? 'L0',
      is_featured: Boolean(featured),
      created_at: createdAt ?? null,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof InvalidOccurredAtError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Register deal document error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to register document' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 });
    }

    const db = createDb();
    const { dealDocumentService } = createContainer(db, await getActiveWorkspaceId());
    await dealDocumentService.delete(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete deal document error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to delete document' },
      { status: 500 },
    );
  }
}
