import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

// `?refresh=1` runs the Analyst agent inline (tool calls + LLM), so allow room
// under the 60s cap. A plain read is a cheap cache lookup.
export const maxDuration = 60;

/**
 * GET /api/dashboard/pulse — the "Today's Recap" daily pipeline pulse: the
 * Analyst agent's markdown, cached once per UTC day per workspace.
 *
 * A plain read only serves the cached row and returns `{ data: null }` on a miss
 * (never generates — that would block the dashboard on an LLM turn). Pass
 * `?refresh=1` to generate/regenerate on demand (the cron and the "Generate now"
 * button).
 */
export async function GET(req: NextRequest) {
  try {
    const refresh = req.nextUrl.searchParams.get('refresh') === '1';

    const db = createDb();
    const { dailyPulseService } = createContainer(db, await getActiveWorkspaceId());
    const data = refresh
      ? await dailyPulseService.generatePulse()
      : await dailyPulseService.getPulse();

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
