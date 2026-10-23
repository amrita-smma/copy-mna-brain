import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { CorrespondentNotFoundError } from '@/lib/services/crmService';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Pick this workspace's primary contact (PIC) for the firm.
 * Body: `{ "correspondent_id": "<uuid>" }`, or `null` to go back to the
 * default (the oldest contact). Other workspaces' picks are untouched.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const correspondentId = body?.correspondent_id;
    if (correspondentId !== null && typeof correspondentId !== 'string') {
      return NextResponse.json(
        { error: 'correspondent_id must be a contact id or null' },
        { status: 400 },
      );
    }
    const session = await auth();
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    await crmService.setPrimaryContact(id, correspondentId, session?.user?.id ?? null);
    return NextResponse.json({ data: { employer_id: id, correspondent_id: correspondentId } });
  } catch (err) {
    if (err instanceof CorrespondentNotFoundError) {
      return NextResponse.json({ error: 'Contact not found at this firm' }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
