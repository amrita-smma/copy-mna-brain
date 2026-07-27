import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { DuplicateEmployerError } from '@/lib/services/crmService';
import { UserWorkspaceRepository, type EmployerListFilters } from '@/lib/repositories';
import { sql } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;
const VAULT_SYNC_CADENCE_MS = DAY_MS;

function lastContactAfter(
  preset: string | null,
  custom: string | null,
  clientTodayIso: string | null,
): string | undefined {
  if (!preset) return undefined;
  const now = Date.now();
  let startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  if (clientTodayIso && !isNaN(Date.parse(clientTodayIso))) {
    startOfDay = new Date(clientTodayIso);
  }

  switch (preset) {
    case 'today':
      return startOfDay.toISOString();
    case 'yesterday':
      return new Date(startOfDay.getTime() - DAY_MS).toISOString();
    case 'week':
      return new Date(now - 7 * DAY_MS).toISOString();
    case 'month':
      return new Date(now - 30 * DAY_MS).toISOString();
    case 'custom':
      if (!custom) return undefined;
      // Custom is YYYY-MM-DD — interpret as start-of-day local
      const customMs = Date.parse(custom);
      return !isNaN(customMs) ? new Date(customMs).toISOString() : undefined;
    default:
      return undefined;
  }
}

function lastContactBefore(preset: string | null): string | undefined {
  if (preset !== 'stale_30') return undefined;
  return new Date(Date.now() - 30 * DAY_MS).toISOString();
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
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
