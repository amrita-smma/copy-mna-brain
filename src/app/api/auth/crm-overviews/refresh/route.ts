import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { InvalidOverviewRefreshSinceError } from '@/lib/services/contactConversationService';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';
// The refresh job runs in `after()` within this budget.
export const maxDuration = 300;

/**
 * POST /api/auth/crm-overviews/refresh  { workspaceIds: string[], since: ISO }
 *
 * Called by the CRM ingest pipeline when a run wrote email notes: regenerates
 * the relationship overview (and its per-deal lines) of each contact touched
 * since `since`, per workspace, up to the service's per-run cap. Gated by the
 * shared-secret `proxy.ts` middleware (`X-Api-Secret` vs `ADMIN_SECRET`) — no
 * session check by design.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      workspaceIds?: unknown;
      since?: unknown;
    } | null;
    const workspaceIds = Array.isArray(body?.workspaceIds)
      ? [...new Set(body.workspaceIds.filter((id): id is string => typeof id === 'string'))]
      : [];
    if (workspaceIds.length === 0 || !workspaceIds.every(isUuid)) {
      return NextResponse.json({ error: 'workspaceIds must be a non-empty list of ids' }, { status: 400 });
    }
    if (typeof body?.since !== 'string') {
      return NextResponse.json({ error: 'since is required' }, { status: 400 });
    }
    const since = body.since;

    const db = createDb();
    const data = [];
    for (const workspaceId of workspaceIds) {
      const { contactConversationService } = createContainer(db, workspaceId);
      const result = await contactConversationService.refreshTouchedOverviews(since);
      data.push({ workspaceId, ...result });
    }
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof InvalidOverviewRefreshSinceError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
