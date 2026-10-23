import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { crmBankersViewEnabled } from '@/lib/flags';
import { InvalidBankerListSortError } from '@/lib/services/bankerListService';

function intParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The CRM Bankers list (MB-858): one row per person visible in the workspace,
 * sorted, filtered and paginated server-side.
 *
 * Query: `q`, `sort` (recent | deals_brought | reached_l1 | team_members |
 * emails), `lastContact` (+ `customDate`, `clientTodayIso`), `team`
 * (comma-separated user ids), `hasDeals=1`, `active30=1`, `page`, `pageSize`
 * (default 25, max 100).
 *
 * Behind `CRM_BANKERS_VIEW_ENABLED`: 404 while the view is off for the
 * workspace.
 */
export async function GET(req: NextRequest) {
  try {
    if (!(await crmBankersViewEnabled())) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const sp = req.nextUrl.searchParams;
    const team = (sp.get('team') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const db = createDb();
    const { bankerListService } = createContainer(db, await getActiveWorkspaceId());
    const data = await bankerListService.listBankers({
      q: sp.get('q'),
      sort: sp.get('sort'),
      lastContact: sp.get('lastContact'),
      customDate: sp.get('customDate'),
      clientTodayIso: sp.get('clientTodayIso'),
      teamUserIds: team,
      hasDeals: sp.get('hasDeals') === '1',
      active30: sp.get('active30') === '1',
      page: intParam(sp.get('page')),
      pageSize: intParam(sp.get('pageSize')),
    });
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof InvalidBankerListSortError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
