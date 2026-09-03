import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { RSS_CATEGORIES } from '@/lib/db/schema';
import type { RssCategory, RssFeedStatus } from '@/lib/db/schema';

/**
 * Admin management of the GLOBAL RSS feed catalog. Gated by the shared-secret
 * `proxy.ts` middleware (`X-Api-Secret` vs `ADMIN_SECRET`) — there is no
 * session check here by design.
 *
 *   GET  /api/auth/rss-feeds?category=…&status=…  — list with health columns
 *   POST /api/auth/rss-feeds                      — create one feed
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const categories = splitEnum<RssCategory>(params.get('category'), RSS_CATEGORIES);
    const statuses = splitEnum<RssFeedStatus>(params.get('status'), [
      'active',
      'paused',
      'dead',
    ]);

    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());
    const data = await rssFeedService.listFeeds({ categories, statuses });
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => undefined);
    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());

    // Reuse the import validator for a single row so create and bulk-import
    // enforce exactly the same rules.
    const { imported, skipped } = await rssFeedService.importFeeds([body]);
    if (skipped.length > 0) {
      return NextResponse.json({ error: skipped[0].reason }, { status: 400 });
    }
    return NextResponse.json({ data: { imported } }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function splitEnum<T extends string>(
  raw: string | null,
  allowed: readonly string[],
): T[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => allowed.includes(value)) as T[];
}
