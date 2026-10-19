import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { RssItemNotFoundError } from '@/lib/services/dataNavigatorService';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = createDb();
    const { dataNavigatorService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dataNavigatorService.getItem(id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof RssItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch news item' }, { status: 500 });
  }
}
