import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { DuplicateEmployerError } from '@/lib/services/crmService';
import type { EmployerListFilters } from '@/lib/repositories';
import { lastContactAfter, lastContactBefore } from '@/lib/crm/lastContactRange';
import { parseEmployerListSort } from '@/lib/crm/employerListSort';

const MAX_LIMIT = 200;

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
      limit: Math.min(Math.max(Number(sp.get('limit')) || 50, 1), MAX_LIMIT),
      offset: Math.max(Number(sp.get('offset')) || 0, 0),
    };

    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { crmService } = createContainer(db, workspaceId);
    // The insights bar is served by GET /api/crm/insights. It is not
    // recomputed here: this endpoint runs on every debounced search keystroke,
    // sort and page change, and the stale-firm count scans email history.
    const { data, total } = await crmService.listEmployers(filters);
    return NextResponse.json({ data, total });
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
