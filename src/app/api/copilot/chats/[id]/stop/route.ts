import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from '@/lib/services/copilotChatsService';

/**
 * Stop the thread's running turn. A chat turn keeps running when the browser
 * disconnects (the user navigated away), so the client's own abort no longer
 * stops it: Stop sets a flag the running turn polls for. `stopped` is false
 * when no turn was running.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: chatId } = await params;

    const db = createDb();
    const { copilotChatsService } = createContainer(db, await getActiveWorkspaceId());
    try {
      await copilotChatsService.assertOwnedBy(chatId, session.user.id);
    } catch (err) {
      if (err instanceof CopilotChatNotFoundError) {
        return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
      }
      if (err instanceof CopilotChatForbiddenError) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      throw err;
    }

    const stopped = await copilotChatsService.requestStop(chatId);
    return NextResponse.json({ data: { stopped } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
