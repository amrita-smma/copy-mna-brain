import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');

    if (!fromParam || !toParam) {
      return NextResponse.json({ error: 'from and to params are required' }, { status: 400 });
    }

    const from = new Date(fromParam);
    const to = new Date(toParam);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return NextResponse.json({ error: 'Invalid date params' }, { status: 400 });
    }

    const db = createDb();
    const { dashboardActivityService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dashboardActivityService.getActivity(from, to);

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
