import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

interface Ctx {
  params: Promise<{ id: string }>;
}

const MAX_CONTACT_IDS = 200;

/**
 * Every contact of this employer mapped to its latest @crm_contact run, keyed
 * by correspondent id. Contacts that have never been enriched are absent.
 *
 * The contacts tab reads this once on open so its fill-contact buttons can
 * render the right state without each row issuing its own request — the
 * client-side fan-out the N+1 rule bans. A button that is actually watching a
 * run polls the per-contact endpoint instead.
 *
 * `?contactId=` (repeatable, 1..MAX_CONTACT_IDS) names the page of contacts
 * the tab is showing. It is required: a firm can have thousands of contacts,
 * so this endpoint never resolves "every contact" by itself.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const contactIds = req.nextUrl.searchParams.getAll('contactId').filter(Boolean);
    if (contactIds.length === 0 || contactIds.length > MAX_CONTACT_IDS) {
      return NextResponse.json(
        { error: `Pass 1 to ${MAX_CONTACT_IDS} contactId values` },
        { status: 400 },
      );
    }
    const db = createDb();
    const { crmContactEnrichmentService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );
    const runs = await crmContactEnrichmentService.latestRunsForEmployer(id, contactIds);
    return NextResponse.json({ data: runs });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
