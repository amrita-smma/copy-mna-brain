import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { MAX_BULK_CONTACT_DISCOVERY } from '@/lib/services/companyContactDiscoveryService';

/** Bounds one GET: a table page asks for its visible rows, not the whole stage. */
const MAX_IDS = 100;

function parseIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return ids.length === raw.length ? ids : null;
}

/**
 * Batched `GET /api/companies/:id/contacts`: `?ids=a,b,c` → each company's
 * CRM firm, ranked partnership contacts and latest @crm_contact run, keyed by
 * company id. One request per table page instead of one per row.
 */
export async function GET(req: NextRequest) {
  try {
    const ids = (req.nextUrl.searchParams.get('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length > MAX_IDS) {
      return NextResponse.json({ error: `At most ${MAX_IDS} ids per request` }, { status: 400 });
    }
    const db = createDb();
    const { companyContactDiscoveryService } = createContainer(db, await getActiveWorkspaceId());
    return NextResponse.json({ data: await companyContactDiscoveryService.getStates(ids) });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Queue a contact search for each of `companyIds` (body). `onlyMissing`
 * skips companies that already have contacts or a finished search.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { companyIds?: unknown; onlyMissing?: unknown }
      | null;
    const companyIds = parseIds(body?.companyIds);
    if (!companyIds) {
      return NextResponse.json({ error: 'companyIds must be an array of ids' }, { status: 400 });
    }
    if (companyIds.length > MAX_BULK_CONTACT_DISCOVERY) {
      return NextResponse.json(
        { error: `At most ${MAX_BULK_CONTACT_DISCOVERY} companies per request` },
        { status: 400 },
      );
    }
    const session = await auth();
    const db = createDb();
    const { companyContactDiscoveryService } = createContainer(db, await getActiveWorkspaceId());
    const result = await companyContactDiscoveryService.discoverMany(companyIds, {
      triggeredByUserId: session?.user?.id ?? null,
      onlyMissing: body?.onlyMissing === true,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
