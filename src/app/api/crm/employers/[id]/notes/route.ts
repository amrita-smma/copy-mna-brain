import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.listNotes(id);
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    if (typeof body?.content !== 'string' || !body.content.trim()) {
      return NextResponse.json(
        { error: 'content is required' },
        { status: 400 },
      );
    }
    const session = await auth();
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    // The author is the signed-in user, never a body field.
    const data = await crmService.addNote({
      employer_id: id,
      content: body.content,
      userId: session?.user?.id ?? null,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
