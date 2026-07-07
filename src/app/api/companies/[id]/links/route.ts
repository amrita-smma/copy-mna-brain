import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { url, title, stage } = await req.json();
    const db = createDb();
    const { dealLinkService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealLinkService.create(id, url, title, stage);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to add link';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
