import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { EmptyNoteError, NoteNotFoundError } from '@/lib/services/dealNoteService';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { content } = await req.json();
    const db = createDb();
    const { dealNoteService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealNoteService.update(id, content);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof EmptyNoteError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof NoteNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error(error);
    const message = error instanceof Error ? error.message : 'Failed to update note';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = createDb();
    const { dealNoteService } = createContainer(db, await getActiveWorkspaceId());
    await dealNoteService.delete(id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete note';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
