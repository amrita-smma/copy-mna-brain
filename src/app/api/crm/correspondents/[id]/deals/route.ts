import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getSession } from '@/lib/server/session';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { crmContactErrorResponse } from '../../errorResponse';

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Manually link the contact to a deal. Body: `{ companyId, role: 'source' | 'involved' }`. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const companyId = typeof body?.companyId === 'string' ? body.companyId.trim() : '';
    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }
    const session = await getSession();
    const db = createDb();
    const { dealContactService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealContactService.addLink(
      id,
      companyId,
      body?.role,
      session?.user?.id ?? null,
    );
    return NextResponse.json({ data });
  } catch (err) {
    return crmContactErrorResponse(err, '[POST /api/crm/correspondents/:id/deals]');
  }
}
