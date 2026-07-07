import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { changeStream, SSE_HEADERS } from '@/lib/server/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * AI Opinion live-updates via Server-Sent Events. Replaces the Pipeline's
 * `setInterval` that re-fetched the whole companies list every 5s while an AI
 * Opinion run was in flight. This streams only the compact set of companies
 * still `processing`; when that set changes (a run finishes) the client does a
 * single companies refresh to swap the spinner for the verdict, instead of
 * polling on a fixed cadence.
 *
 * Auth: `session` mode in `proxy.ts` — the browser's `EventSource` sends the
 * NextAuth session cookie automatically.
 *
 *   GET /api/companies/stream
 */
export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());

    const stream = changeStream({
      snapshot: () => companyService.findProcessingAiOpinions(),
      signature: (rows) =>
        rows
          .map((r) => `${r.id}:${r.ai_opinion_status ?? ''}`)
          .sort()
          .join('|'),
      signal: req.signal,
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to stream companies';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
