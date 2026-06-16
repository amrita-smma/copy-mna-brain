import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { isCacheableResponse } from '@/lib/services/copilotChatsService';
import { getAgentGraph, extractFirstTurn } from '@/lib/agents/analysis';

/**
 * Chat cache lookup. Given the first user message of a brand-new chat, find a
 * prior chat that started with the same (normalized) question and return its
 * turn-1 answer. The client uses this to warn the user before re-running the
 * agent, offering to continue from the cached chat or start fresh.
 *
 * Only meaningful for the first turn of a new chat — the client gates the call.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const message: unknown = body?.message;
    if (typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ data: { hit: false } });
    }

    const db = createDb();
    const { copilotChatsService } = createContainer(db);

    const match = await copilotChatsService.findCachedFirstTurn(message);
    if (!match) {
      return NextResponse.json({ data: { hit: false } });
    }

    const agent = await getAgentGraph();
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
