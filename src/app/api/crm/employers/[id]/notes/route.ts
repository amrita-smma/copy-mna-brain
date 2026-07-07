import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

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
    if (!body?.content || typeof body.content !== 'string') {
      return NextResponse.json(
        { error: 'content is required' },
        { status: 400 },
      );
    }
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.addNote({
      employer_id: id,
      author_user_id: body.author_user_id ?? null,
      content: body.content,
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
