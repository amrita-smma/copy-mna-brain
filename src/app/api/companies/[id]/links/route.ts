import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { InvalidOccurredAtError } from '@/lib/timeline/occurredAt';
import { UnsupportedFeaturedSlideError } from '@/lib/services/featuredSlide';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { url, title, stage, createdAt, featured } = await req.json();
    const db = createDb();
    const { dealLinkService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealLinkService.create(id, url, title, stage, createdAt, Boolean(featured));
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof InvalidOccurredAtError || error instanceof UnsupportedFeaturedSlideError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to add link';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
