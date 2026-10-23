import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getSession } from '@/lib/server/session';
import { crmEmailNotesEnabled } from '@/lib/flags';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { crmContactErrorResponse } from '../../errorResponse';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Returns conversation notes, roles rollup, overview and synced status for one contact.
 * Query params:
 *   - cursor: optional opaque keyset cursor
 *   - limit: optional integer 1..50, default 20
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    // Notes are private to the people on each email, so they are read as the
    // signed-in user and never for anyone else.
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const searchParams = req.nextUrl?.searchParams;

    const limitParam = searchParams?.get('limit');
    let limit: number | undefined;
    if (limitParam !== null && limitParam !== undefined) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
        return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
      }
      limit = parsed;
    }

    const cursor = searchParams?.get('cursor') ?? undefined;

    const db = createDb();
    const { contactConversationService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );

    const data = await contactConversationService.getConversation(id, userId, {
      // `CRM_EMAIL_NOTES_ENABLED` off: no notes list at all.
      includeNotes: Boolean(await crmEmailNotesEnabled()),
      cursor,
      limit,
    });

    return NextResponse.json({ data });
  } catch (err) {
    return crmContactErrorResponse(err, '[GET /api/crm/correspondents/:id/conversation]');
  }
}
