import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  try {
    const { companyId } = await params;

    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    const db = createDb();
    const { dashboardActivityService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dashboardActivityService.getCompanyTimeline(companyId);

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
