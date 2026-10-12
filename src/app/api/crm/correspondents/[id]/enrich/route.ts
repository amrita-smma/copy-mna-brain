import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Queue an @crm_contact run that fills this contact's empty profile fields
 * from the public web. Returns immediately with the run — research takes
 * minutes, so the button polls GET below rather than holding the request.
 *
 * 200 either way: an in-flight run is reported back as-is (`created: false`)
 * rather than treated as a conflict, because the caller wanted the contact
 * enriched and it already is being.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const session = await auth();
    const db = createDb();
    const { crmContactEnrichmentService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );
    const { run, created } = await crmContactEnrichmentService.enrich(id, {
      triggeredByUserId: session?.user?.id ?? null,
    });
    return NextResponse.json({ data: { ...run, created } });
  } catch (err) {
    if (err instanceof ContactNotFoundError) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * The latest enrichment run for this contact, or `null` if there has never
 * been one. The button polls this while `active` is true, then reads `status`
 * to decide between a success toast and the failure message.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const db = createDb();
    const { crmContactEnrichmentService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );
    const run = await crmContactEnrichmentService.latestRun(id);
    return NextResponse.json({ data: run });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
