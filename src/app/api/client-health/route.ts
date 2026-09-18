import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';
import { parseClientHealthReason } from '@/lib/services/clientHealthService';

/**
 * Where a browser reports that it cannot reach our `/ingest` PostHog proxy.
 *
 * Session-gated by `proxy.ts` like every other `/api/*` route, which is also
 * what makes the report useful: it identifies *which* user is dark.
 *
 * The path deliberately avoids `analytics` / `tracking` / `telemetry` /
 * `posthog` / `ph` — all of which appear in the very filter lists this route
 * exists to measure, and any of which would get the report blocked too.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const reason = parseClientHealthReason((body as { reason?: unknown } | null)?.reason);
    if (!reason) {
      return NextResponse.json({ error: 'Unknown reason' }, { status: 400 });
    }

    const db = createDb();
    const { clientHealthService } = createContainer(db, await getActiveWorkspaceId());
    clientHealthService.recordBlockedClient({
      userId,
      reason,
      userAgent: req.headers.get('user-agent'),
    });

    return NextResponse.json({ data: { recorded: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
