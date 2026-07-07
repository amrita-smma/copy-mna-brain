import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { DuplicateEmployerError } from '@/lib/services/crmService';
import { JobRepository, UserWorkspaceRepository, type EmployerListFilters } from '@/lib/repositories';
import { VAULT_SYNC_CADENCE_MS } from '@/lib/jobs/handlers/vaultExport';

const DAY_MS = 24 * 60 * 60 * 1000;

function lastContactAfter(
  preset: string | null,
  custom: string | null,
): string | undefined {
  if (!preset) return undefined;
  const now = Date.now();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
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
      return new Date(custom).toISOString();
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
    const jobRepo = new JobRepository(db);
    const lastSyncJob = await jobRepo.findLatestByTypeAndStatus(
      'vault_export',
      'completed',
    );
    const { data, total } = await crmService.listEmployers(filters);
    const vaultCustodianCount = await new UserWorkspaceRepository(db).countSyncedCustodians(
      workspaceId,
    );
    const insights = await crmService.insights({
      vaultCustodianCount,
      lastVaultSyncedAt: lastSyncJob?.completed_at ?? null,
      vaultSyncCadenceMs: VAULT_SYNC_CADENCE_MS,
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
