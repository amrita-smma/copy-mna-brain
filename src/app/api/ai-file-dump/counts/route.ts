import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * Lightweight endpoint returning file counts per tab bucket in a single query.
 * Used by the AI File Dump view to populate tab badges without loading row data.
 */
export async function GET() {
  try {
    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const counts = await fileService.countsByType();
    return NextResponse.json({ success: true, counts });
  } catch (error) {
    console.error('Counts error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to fetch counts' },
      { status: 500 },
    );
  }
}
