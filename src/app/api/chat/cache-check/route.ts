import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { isCacheableResponse } from '@/lib/services/copilotChatsService';
import { extractFirstTurn } from '@/lib/agents/analysis';
import { chatCacheEnabled } from '@/lib/flags';
import { sanitizePageContext } from '@/lib/chat/pageContext';
import { getChatAgentGraph, resolveChatAgentKey } from '@/lib/chat/chatAgent';
import { toChatAgentKey } from '@/lib/chat/chatAgentKey';

/**
 * Chat cache lookup. Given the first user message of a brand-new chat, find a
 * prior chat that started with the same (normalized) question and return its
 * turn-1 answer. The client uses this to warn the user before re-running the
 * agent, offering to continue from the cached chat or start fresh.
 *
 * Only meaningful for the first turn of a new chat — the client gates the call.
 *
 * A cached answer is only offered when it came from the agent the new chat
 * would run on (MB-549): the client sends its `page_context`, and the match is
 * scoped to the agent that page resolves to. A new chat opened on an insight
 * always misses (MB-550): its turn carries that insight's outline, so its
 * answer depends on that insight — and a first turn is never written to the
 * cache from an insight page either.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Chat caching is behind a feature flag. When disabled, always report a
    // miss so the client sends the message normally and never surfaces the
    // cached-chat dialog.
    if (!(await chatCacheEnabled())) {
      return NextResponse.json({ data: { hit: false } });
    }

    const body = await req.json();
    const message: unknown = body?.message;
    if (typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ data: { hit: false } });
    }

    const pageContext = sanitizePageContext(body?.page_context);
    if (pageContext?.insightId) {
      return NextResponse.json({ data: { hit: false } });
    }

    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { copilotChatsService, insightService } = createContainer(db, workspaceId);

    // What the new chat would run on — a preview, nothing is pinned.
    const wouldRun = await resolveChatAgentKey(
      { chat: null, pageContext },
      { workspaceId, copilotChatsService, insightService },
    );
    if (wouldRun.notice) {
      return NextResponse.json({ data: { hit: false } });
    }

    const match = await copilotChatsService.findCachedFirstTurn(message, wouldRun.agentKey);
    if (!match) {
      return NextResponse.json({ data: { hit: false } });
    }

    const agent = await getChatAgentGraph(toChatAgentKey(match.agent_key));
    if (!agent) {
      return NextResponse.json({ data: { hit: false } });
    }

    const messages = await agent.getMessages(match.id);
    const { userText, assistantText } = extractFirstTurn(messages);

    // Only a real hit when the prior turn-1 produced a substantial answer
    // (more than 6 words) — trivially short replies aren't worth reusing.
    if (!isCacheableResponse(assistantText)) {
      return NextResponse.json({ data: { hit: false } });
    }

    return NextResponse.json({
      data: {
        hit: true,
        chatId: match.id,
        createdAt: match.created_at,
        firstUserMessage: userText,
        firstAssistantMessage: assistantText,
      },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
