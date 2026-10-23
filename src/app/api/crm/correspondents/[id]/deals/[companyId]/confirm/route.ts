import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getSession } from '@/lib/server/session';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { crmContactErrorResponse } from '../../../../errorResponse';

interface Ctx {
  params: Promise<{ id: string; companyId: string }>;
}

/** Confirm a suggested deal: the contact becomes `involved` in it. */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, companyId } = await ctx.params;
    const session = await getSession();
    const db = createDb();
    const { dealContactService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealContactService.confirmSuggestion(
      id,
      companyId,
      session?.user?.id ?? null,
    );
    return NextResponse.json({ data });
  } catch (err) {
    return crmContactErrorResponse(err, '[POST /api/crm/correspondents/:id/deals/:companyId/confirm]');
  }
}
