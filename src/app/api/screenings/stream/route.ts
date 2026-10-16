import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { changeStream, SSE_HEADERS } from '@/lib/server/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Screenings live-updates via Server-Sent Events. Replaces the client-side
 * `setInterval` pollers on the Pipeline (Pending Confirmation + L0 pending set) and the Company
 * Detail views: one long-lived connection pushes the full screenings list
 * whenever any row's state/result changes, instead of each client re-requesting
 * every few seconds.
 *
 * Auth: `session` mode in `proxy.ts` — the browser's `EventSource` sends the
 * NextAuth session cookie automatically (EventSource cannot set the
 * `X-Api-Secret` header, so this relies on the cookie, same as the GET route).
 *
 *   GET /api/screenings/stream?companyId=...   (or ?inScreening=true)
 */
export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { screeningService } = createContainer(db, await getActiveWorkspaceId());
    const params = req.nextUrl.searchParams;
    const companyId = params.get('companyId') ?? undefined;
    const inScreening = params.get('inScreening') === 'true';

    const stream = changeStream({
      snapshot: () => screeningService.findAll({ companyId, inScreening }),
      signature: (rows) =>
        rows
          .map((r) => `${r.id}:${r.state}:${r.result ?? ''}:${r.updated_at ?? ''}`)
          .join('|'),
      signal: req.signal,
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to stream screenings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
