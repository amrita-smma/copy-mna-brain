import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { DuplicateEmployerError } from '@/lib/services/crmService';
import { UserWorkspaceRepository, type EmployerListFilters } from '@/lib/repositories';
import { sql } from 'drizzle-orm';
import { lastContactAfter, lastContactBefore } from '@/lib/crm/lastContactRange';
import { parseEmployerListSort } from '@/lib/crm/employerListSort';

const DAY_MS = 24 * 60 * 60 * 1000;
const VAULT_SYNC_CADENCE_MS = DAY_MS;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const { sort, dir } = parseEmployerListSort(sp.get('sort'), sp.get('dir'));
    const filters: EmployerListFilters = {
      search: sp.get('q')?.trim() || undefined,
      status: (sp.get('status') as 'inbound' | 'outbound' | null) ?? undefined,
      curationStatus:
        (sp.get('curationStatus') as 'published' | 'flagged' | null) ??
        'published',
      lastContactAfter: lastContactAfter(
        sp.get('lastContact'),
        sp.get('customDate'),
        sp.get('clientTodayIso'),
      ),
      lastContactBefore: lastContactBefore(sp.get('lastContact')),
      topicIds: sp.getAll('topicId').filter(Boolean),
      teamUserIds: sp.getAll('teamUserId').filter(Boolean),
      sort,
      sortDir: dir,
      limit: Number(sp.get('limit')) || 50,
      offset: Number(sp.get('offset')) || 0,
    };

    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { crmService } = createContainer(db, workspaceId);
    const { rows: lastSyncRows } = await db.execute<{ synced_at: string | null }>(
      sql`SELECT updated_at::text AS synced_at
          FROM analytics.vault_exports
          WHERE status IN ('archived', 'archived_partial')
          ORDER BY updated_at DESC
          LIMIT 1`,
    );
    const lastVaultSyncedAt = lastSyncRows[0]?.synced_at ?? null;
    const { data, total } = await crmService.listEmployers(filters);
    const vaultCustodianCount = await new UserWorkspaceRepository(db).countSyncedCustodians(
      workspaceId,
    );
    const clientTodayIsoStr = sp.get('clientTodayIso');
    const clientTodayIso =
      clientTodayIsoStr && !isNaN(Date.parse(clientTodayIsoStr))
        ? new Date(clientTodayIsoStr).toISOString()
        : undefined;

    const insights = await crmService.insights({
      vaultCustodianCount,
      lastVaultSyncedAt,
      vaultSyncCadenceMs: VAULT_SYNC_CADENCE_MS,
      clientTodayIso,
    });
    return NextResponse.json({ data, total, insights });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body?.name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.createEmployer({
      name: body.name,
      industry: body.industry,
      status: body.status,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateEmployerError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
