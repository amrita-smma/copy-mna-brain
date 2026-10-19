import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/**
 * Lightweight endpoint returning file counts per tab bucket in a single query.
 * Used by the Smart Files view to populate tab badges without loading row data.
 * `?search=` narrows the counts to the same matches the list endpoint returns,
 * so every tab's badge tracks the search bar, not just the active tab's.
 */
export async function GET(request: NextRequest) {
  try {
    const search = request.nextUrl.searchParams.get('search') ?? undefined;
    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const counts = await fileService.countsByType(search);
    return NextResponse.json({ success: true, counts });
  } catch (error) {
    console.error('Counts error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to fetch counts' },
      { status: 500 },
    );
  }
}
