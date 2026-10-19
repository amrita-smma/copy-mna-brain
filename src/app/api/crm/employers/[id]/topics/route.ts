import { NextRequest, NextResponse } from 'next/server';
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
    const data = await crmService.listEmployerTopics(id);
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
    const name: string = body?.name?.trim();
    if (!name) {
      return NextResponse.json(
        { error: 'name is required' },
        { status: 400 },
      );
    }
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.addTopicToEmployer(id, name, {
      source: 'manual',
      is_highlight: !!body.is_highlight,
      is_deal_related: !!body.is_deal_related,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Maximum') || msg.includes('already')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
