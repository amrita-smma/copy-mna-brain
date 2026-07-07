import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

interface Ctx {
  params: Promise<{ id: string; relatedCompanyId: string }>;
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, relatedCompanyId } = await ctx.params;
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    await crmService.removeRelatedCompanyFromEmployer(id, relatedCompanyId);
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
