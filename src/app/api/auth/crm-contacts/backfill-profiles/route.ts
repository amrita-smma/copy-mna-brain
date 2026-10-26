import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/auth/crm-contacts/backfill-profiles
 *   { workspaceId: uuid, limit: number, minEmailsFromThem?: number }
 *
 * Queues Get Full Profile runs for existing contacts with a two-way exchange
 * and no bio, most recently heard from first — the one-off backfill behind the
 * hourly sweep, which only takes new relationships. `limit` is capped per
 * call; call again to continue (a contact already run is never picked twice).
 * Gated by the shared-secret `proxy.ts` middleware (`X-Api-Secret` vs
 * `ADMIN_SECRET`) — no session check by design.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      workspaceId?: unknown;
      limit?: unknown;
      minEmailsFromThem?: unknown;
    } | null;
    const workspaceId = body?.workspaceId;
    if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) {
      return NextResponse.json({ error: 'workspaceId must be a workspace id' }, { status: 400 });
    }
    const limit = body?.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 });
    }
    const minEmails = body?.minEmailsFromThem ?? 1;
    if (typeof minEmails !== 'number' || !Number.isInteger(minEmails) || minEmails < 1) {
      return NextResponse.json({ error: 'minEmailsFromThem must be a positive integer' }, { status: 400 });
    }

    const db = createDb();
    const { crmContactEnrichmentService } = createContainer(db, workspaceId);
    const data = await crmContactEnrichmentService.backfillProfiles(limit, minEmails);
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
