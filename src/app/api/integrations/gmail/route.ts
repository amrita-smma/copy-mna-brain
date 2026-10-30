import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { gmailEnabled } from '@/lib/flags';

/**
 * The signed-in member's Gmail connection — the Connected apps row. Always the
 * session user; there is no `userId` param.
 *
 * `enabled` is the workspace's GMAIL_ENABLED flag (set by a superadmin in the
 * admin portal); `configured` is whether this deployment has a Google OAuth
 * client for Gmail at all. The connection itself is per person and not per
 * workspace, so it is reported either way.
 */
export async function GET() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const enabled = await gmailEnabled();
    const { gmailService } = createContainer(createDb(), await getActiveWorkspaceId());
    const status = await gmailService.getStatus(userId);
    return NextResponse.json({ data: { enabled, configured: gmailService.isConfigured(), ...status } });
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
    const { gmailService } = createContainer(createDb(), await getActiveWorkspaceId());
    await gmailService.disconnect(userId);
    return NextResponse.json({ data: { connected: false } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
