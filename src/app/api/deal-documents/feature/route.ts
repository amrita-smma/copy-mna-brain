import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/**
 * POST - Feature an already-uploaded attachment as the deal's Featured Slide,
 * without re-uploading it.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dealId, documentId } = body;

    if (!dealId || !documentId) {
      return NextResponse.json(
        { error: 'dealId and documentId are required' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { dealDocumentService } = createContainer(db, await getActiveWorkspaceId());
    await dealDocumentService.setFeatured(dealId, documentId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Feature deal document error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to set featured slide' },
      { status: 500 },
    );
  }
}

/**
 * DELETE - Unfeature the deal's current featured slide. The underlying
 * document is left in place as a regular attachment.
 */
export async function DELETE(request: NextRequest) {
  try {
    const dealId = request.nextUrl.searchParams.get('dealId');
    if (!dealId) {
      return NextResponse.json({ error: 'dealId query parameter is required' }, { status: 400 });
    }

    const db = createDb();
    const { dealDocumentService } = createContainer(db, await getActiveWorkspaceId());
    await dealDocumentService.clearFeatured(dealId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Unfeature deal document error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to remove featured slide' },
      { status: 500 },
    );
  }
}
