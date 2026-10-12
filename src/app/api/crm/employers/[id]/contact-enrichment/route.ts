import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Every contact of this employer mapped to its latest @crm_contact run, keyed
 * by correspondent id. Contacts that have never been enriched are absent.
 *
 * The contacts tab reads this once on open so its fill-contact buttons can
 * render the right state without each row issuing its own request — the
 * client-side fan-out the N+1 rule bans. A button that is actually watching a
 * run polls the per-contact endpoint instead.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const db = createDb();
    const { crmContactEnrichmentService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );
    const runs = await crmContactEnrichmentService.latestRunsForEmployer(id);
    return NextResponse.json({ data: runs });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
