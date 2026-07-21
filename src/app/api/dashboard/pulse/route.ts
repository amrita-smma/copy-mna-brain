import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

// On a cache miss the Analyst agent runs inline (tool calls + LLM), so allow
// room under the 60s cap; the daily cron normally precomputes it.
export const maxDuration = 60;

/**
 * GET /api/dashboard/pulse — the "Today's Recap" daily pipeline pulse: the
 * Analyst agent's markdown, cached once per UTC day per workspace. Pass
 * `?refresh=1` to regenerate on demand (used by the cron / ops).
 */
export async function GET(req: NextRequest) {
  try {
    const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1';

    const db = createDb();
    const { dailyPulseService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dailyPulseService.getPulse({ forceRefresh });

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
