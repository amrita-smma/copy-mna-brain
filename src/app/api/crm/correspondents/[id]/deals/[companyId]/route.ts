import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { crmContactErrorResponse } from '../../../errorResponse';

interface Ctx {
  params: Promise<{ id: string; companyId: string }>;
}

/**
 * Remove the contact's link to a deal. The link is kept as dismissed, so the
 * automatic paths never add it back.
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, companyId } = await ctx.params;
    const db = createDb();
    const { dealContactService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dealContactService.removeLink(id, companyId);
    return NextResponse.json({ data });
  } catch (err) {
    return crmContactErrorResponse(err, '[DELETE /api/crm/correspondents/:id/deals/:companyId]');
  }
}
