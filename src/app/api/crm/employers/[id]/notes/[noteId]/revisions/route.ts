import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

interface Ctx {
  params: Promise<{ id: string; noteId: string }>;
}

/** A firm note's audit trail — every create, edit and delete, oldest first. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { noteId } = await ctx.params;
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.listNoteRevisions(noteId);
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
