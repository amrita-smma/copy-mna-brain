import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const updates = await req.json();
    const db = createDb();
    const { screeningService } = createContainer(db, await getActiveWorkspaceId());
    const data = await screeningService.update(id, updates);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update screening';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
