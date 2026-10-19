import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  extractFirstTurn,
  HumanMessage,
  AIMessage,
} from '@/lib/agents/analysis';
import { chatCacheEnabled } from '@/lib/flags';
import { getChatAgentGraph } from '@/lib/chat/chatAgent';
import { toChatAgentKey } from '@/lib/chat/chatAgentKey';
import { isUuid } from '@/lib/uuid';

/**
 * Fork a cached chat's turn-1 into a brand-new chat owned by the requesting
 * user. The source chat may belong to anyone (the cache is global), so we
 * never expose its full thread — we copy only the first question + first
 * answer into a fresh, isolated thread the caller owns and can continue from.
 *
 * The fork runs on the same agent as its source (MB-549): the source's pinned
 * `agent_key` is copied onto the new chat, so the continued thread keeps the
 * agent that produced the answer it starts from.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const sourceChatId: unknown = body?.sourceChatId;
    if (typeof sourceChatId !== 'string' || !sourceChatId) {
      return NextResponse.json({ error: 'sourceChatId is required' }, { status: 400 });
    }
    if (!isUuid(sourceChatId)) {
      return NextResponse.json({ error: 'sourceChatId must be a UUID' }, { status: 400 });
    }

    const db = createDb();
    const { copilotChatsService } = createContainer(db, await getActiveWorkspaceId());

    // The cache is workspace-global, so the source may be a colleague's chat —
    // but never another workspace's.
    const source = await copilotChatsService.findInWorkspace(sourceChatId);
    if (!source) {
      return NextResponse.json({ error: 'Source chat not found' }, { status: 404 });
    }
    const agentKey = toChatAgentKey(source.agent_key);

    const agent = await getChatAgentGraph(agentKey);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not available' }, { status: 500 });
    }

    const sourceMessages = await agent.getMessages(sourceChatId);
    const { userText, assistantText } = extractFirstTurn(sourceMessages);
    if (!userText.trim() || !assistantText.trim()) {
      return NextResponse.json({ error: 'Source chat has no cached turn' }, { status: 404 });
    }

    const chat = await copilotChatsService.create(userId, agentKey);
    await agent.seedMessages(chat.id, [
      new HumanMessage(userText),
      new AIMessage(assistantText),
    ]);
    await copilotChatsService.setTitle(chat.id, userText.slice(0, 80));
    // Keep the fork itself cacheable for the next identical question — but only
    // when caching is enabled, so nothing is written to the cache while the
    // feature flag is off.
    if (await chatCacheEnabled()) {
      await copilotChatsService.recordFirstMessage(chat.id, userText);
    }

    return NextResponse.json({ data: { chatId: chat.id } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
