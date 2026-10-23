import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { crmContactErrorResponse } from '../../../errorResponse';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Requests or checks relationship overview for a contact.
 * Dispatches an overview generation job when needed and returns the current/pending state.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const db = createDb();
    const { contactConversationService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );

    const data = await contactConversationService.requestOverview(id);
    return NextResponse.json({ data });
  } catch (err) {
    return crmContactErrorResponse(err, '[POST /api/crm/correspondents/:id/conversation/overview]');
  }
}
