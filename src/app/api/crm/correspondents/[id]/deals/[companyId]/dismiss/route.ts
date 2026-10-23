import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { crmContactErrorResponse } from '../../../../errorResponse';

interface Ctx {
  params: Promise<{ id: string; companyId: string }>;
}

/** Dismiss a suggested deal for good: it is never suggested or auto-linked again. */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, companyId } = await ctx.params;
    const db = createDb();
    const { dealContactService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealContactService.dismissSuggestion(id, companyId);
    return NextResponse.json({ data });
  } catch (err) {
    return crmContactErrorResponse(err, '[POST /api/crm/correspondents/:id/deals/:companyId/dismiss]');
  }
}
