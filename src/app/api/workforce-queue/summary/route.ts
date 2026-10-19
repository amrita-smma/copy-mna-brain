import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/**
 * The Workforce nav item's badges: the caller's unseen failed runs (red), the
 * workspace's queue (yellow) and whether anything is running (the blinking
 * dot). Polled by the sidebar, so it is one aggregate query.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = createDb();
    const { aiWorkforceService } = createContainer(db, await getActiveWorkspaceId());
    const data = await aiWorkforceService.getNavSummary(session.user.id);
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
