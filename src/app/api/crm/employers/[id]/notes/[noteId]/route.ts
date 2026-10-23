import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { EmployerNoteNotFoundError } from '@/lib/services/crmService';

interface Ctx {
  params: Promise<{ id: string; noteId: string }>;
}

/**
 * Edit a firm note. Anyone in the workspace may; the change is audited in
 * employer_note_revisions with the signed-in user as the editor.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { noteId } = await ctx.params;
    const body = await req.json().catch(() => null);
    if (typeof body?.content !== 'string' || !body.content.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }
    const session = await auth();
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.updateNote(
      noteId,
      body.content,
      session?.user?.id ?? null,
    );
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof EmployerNoteNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** Soft-delete a firm note; its history stays readable through /revisions. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { noteId } = await ctx.params;
    const session = await auth();
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    await crmService.deleteNote(noteId, session?.user?.id ?? null);
    return NextResponse.json({ data: { id: noteId } });
  } catch (err) {
    if (err instanceof EmployerNoteNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
