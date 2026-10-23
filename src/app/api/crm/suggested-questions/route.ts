import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getSession } from '@/lib/server/session';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/**
 * The signed-in user's "Ask Brain" questions for today in the active
 * workspace (MB-861/862): `{ personalized, generic, hasSync, stale }`.
 * Generated on demand when the daily cron has not written today's row.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { crmSuggestedQuestionService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmSuggestedQuestionService.getForUser(session.user.id);
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
