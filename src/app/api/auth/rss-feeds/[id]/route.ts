import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { RssFeedNotFoundError } from '@/lib/services/rssFeedService';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const updates = await req.json().catch(() => undefined);
    if (typeof updates !== 'object' || updates === null) {
      return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
    }

    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());
    const data = await rssFeedService.updateFeed(id, updates);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof RssFeedNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());
    await rssFeedService.deleteFeed(id);
    return NextResponse.json({ data: { success: true } });
  } catch (err) {
    if (err instanceof RssFeedNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
