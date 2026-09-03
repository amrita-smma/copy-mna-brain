import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * Bulk, idempotent catalog import — the seeding path for staging/production.
 * Body: `{ "feeds": [ { category, source_name, feed_url, region?, tier?, ... } ] }`
 * Upserts on `feed_url`; invalid rows are reported in `skipped`, not thrown.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => undefined);
    const feeds = (body as { feeds?: unknown } | undefined)?.feeds;
    if (!Array.isArray(feeds)) {
      return NextResponse.json({ error: 'feeds must be an array' }, { status: 400 });
    }

    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());
    const data = await rssFeedService.importFeeds(feeds);
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
