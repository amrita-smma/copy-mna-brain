import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from '@/lib/services/copilotChatsService';
import { getChatAgentGraph } from '@/lib/chat/chatAgent';
import { toChatAgentKey } from '@/lib/chat/chatAgentKey';

/** Parse a positive integer query param; anything else is treated as absent. */
function intParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * One page of a thread's history, oldest first. `?before=<cursor>` reads the
 * page before an earlier response's `nextCursor`; `?turns=` sets its size in
 * turns (default `CHAT_HISTORY_PAGE_TURNS`).
 * Served from `copilot_messages`; a thread that predates the table has its
 * checkpoint history imported on first read.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: chatId } = await params;

    const db = createDb();
    const { copilotChatsService, chatHistoryService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );

    let chat;
    try {
      chat = await copilotChatsService.assertOwnedBy(chatId, session.user.id);
    } catch (err) {
      if (err instanceof CopilotChatNotFoundError) {
        return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
      }
      if (err instanceof CopilotChatForbiddenError) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      throw err;
    }

    const search = req.nextUrl.searchParams;
    const page = await chatHistoryService.page(
      chat,
      { before: intParam(search.get('before')), turns: intParam(search.get('turns')) },
      // Read through the thread's own agent. Every graph shares one
      // checkpointer, so this never pins or resolves anything.
      async () => {
        const agent = await getChatAgentGraph(toChatAgentKey(chat.agent_key));
        return agent ? agent.getMessages(chatId) : [];
      },
    );
    return NextResponse.json(page);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
