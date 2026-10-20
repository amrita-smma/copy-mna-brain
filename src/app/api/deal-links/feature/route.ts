import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { UnsupportedFeaturedSlideError } from '@/lib/services/featuredSlide';

/**
 * POST - Feature a YouTube link already on the deal's timeline as its Featured
 * Slide. Unfeaturing goes through `DELETE /api/deal-documents/feature`, which
 * clears whichever document or link holds it.
 */
export async function POST(request: NextRequest) {
  try {
    const { dealId, linkId } = await request.json();

    if (!dealId || !linkId) {
      return NextResponse.json({ error: 'dealId and linkId are required' }, { status: 400 });
    }

    const db = createDb();
    const { dealLinkService } = createContainer(db, await getActiveWorkspaceId());
    await dealLinkService.setFeatured(dealId, linkId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof UnsupportedFeaturedSlideError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Feature deal link error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to set featured slide' },
      { status: 500 },
    );
  }
}
