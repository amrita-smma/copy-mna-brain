import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    const data = await companyService.runL1Filters(id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to run L1 filters';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
