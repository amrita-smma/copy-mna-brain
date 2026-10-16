import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { changeStream, SSE_HEADERS } from '@/lib/server/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Live AI screening task status for the Pipeline's AI Screening panel, via
 * Server-Sent Events: the newest `ai_screening` AI Workforce task of every
 * active Pending Confirmation and L0 company, pushed whenever one is queued,
 * starts or ends. A task's status changes don't touch its `screenings` rows,
 * so `/api/screenings/stream` alone can't show "queued" vs "running".
 *
 * Auth: `session` mode in `proxy.ts`, as for `/api/screenings/stream`.
 *
 *   GET /api/ai-screening/tasks/stream
 */
export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { aiScreeningService } = createContainer(db, await getActiveWorkspaceId());

    const stream = changeStream({
      snapshot: () => aiScreeningService.listCompanyTasks(),
      signature: (tasks) => tasks.map((t) => `${t.runId}:${t.status}`).join('|'),
      signal: req.signal,
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
