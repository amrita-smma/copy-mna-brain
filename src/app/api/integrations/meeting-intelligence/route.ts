import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { meetingIntelligenceEnabled } from '@/lib/flags';

/**
 * The signed-in member's Meeting Intelligence connection — the Profile card.
 * Always the session user; there is no `userId` param.
 *
 * `enabled` is the workspace's MEETING_INTELLIGENCE_ENABLED flag (set by a
 * superadmin in the admin portal). The connection itself is per person and
 * not per workspace, so it is reported either way.
 */
export async function GET() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const enabled = await meetingIntelligenceEnabled();
    const { meetingIntelligenceService } = createContainer(createDb(), await getActiveWorkspaceId());
    const status = await meetingIntelligenceService.getStatus(userId);
    return NextResponse.json({ data: { enabled, ...status } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Disconnect: revoke the grant and delete the stored tokens. Allowed even
 * when the workspace flag is off, so a member can always withdraw access.
 */
export async function DELETE() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { meetingIntelligenceService } = createContainer(createDb(), await getActiveWorkspaceId());
    await meetingIntelligenceService.disconnect(userId);
    return NextResponse.json({ data: { connected: false } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
