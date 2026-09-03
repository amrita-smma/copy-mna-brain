import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET() {
  try {
    const db = createDb();
    const { dataNavigatorService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dataNavigatorService.listFilterOptions();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch filter options' }, { status: 500 });
  }
}
