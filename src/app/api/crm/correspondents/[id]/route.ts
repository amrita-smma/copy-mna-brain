import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { pickEditableContactFields } from '@/lib/services/crmService';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    // Whitelist: the client must never be able to set machine-owned columns
    // (employer_id, origin, source, is_primary) by naming them in the body.
    const patch = pickEditableContactFields(body as Record<string, unknown>);
    if ('name' in patch && !patch.name) {
      return NextResponse.json(
        { error: 'name cannot be empty' },
        { status: 400 },
      );
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No editable fields' }, { status: 400 });
    }
    const session = await auth();
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    // Only stamp the editor when we actually know who it is — passing null
    // would clear whoever edited the row last.
    const editorId = session?.user?.id;
    const data = await crmService.updateContact(id, {
      ...patch,
      ...(editorId ? { last_edited_by_user_id: editorId } : {}),
    });
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    await crmService.deleteContact(id);
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
