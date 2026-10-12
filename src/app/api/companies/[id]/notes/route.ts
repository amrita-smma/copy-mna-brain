import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { InvalidOccurredAtError } from '@/lib/timeline/occurredAt';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { content, stage, createdAt } = await req.json();
    const db = createDb();
    const { dealNoteService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealNoteService.create(id, content, stage, createdAt);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof InvalidOccurredAtError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to add note';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
