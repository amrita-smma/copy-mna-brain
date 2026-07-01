import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

interface Ctx {
  params: Promise<{ id: string; topicId: string }>;
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { topicId } = await ctx.params;
    const body = await req.json();
    if (typeof body?.is_deal_related !== 'boolean') {
      return NextResponse.json({ error: 'is_deal_related (boolean) is required' }, { status: 400 });
    }
    const db = createDb();
    const { crmService } = createContainer(db);
    await crmService.reclassifyTopic(topicId, body.is_deal_related);
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, topicId } = await ctx.params;
    const db = createDb();
    const { crmService } = createContainer(db);
    await crmService.removeTopicFromEmployer(id, topicId);
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
