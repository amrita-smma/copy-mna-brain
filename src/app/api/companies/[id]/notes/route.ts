import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { content, stage } = await req.json();
    const db = createDb();
    const { dealNoteService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealNoteService.create(id, content, stage);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to add note';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
