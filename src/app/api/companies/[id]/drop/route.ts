import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { currentStage, reason } = await req.json();
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    await companyService.dropDeal(id, currentStage, reason);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to drop deal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
