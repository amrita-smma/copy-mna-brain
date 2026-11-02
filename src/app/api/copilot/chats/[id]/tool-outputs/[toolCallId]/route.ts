import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  CopilotChatNotFoundError,
  CopilotChatForbiddenError,
} from '@/lib/services/copilotChatsService';

/**
 * One tool call's whole stored output. History pages and live replies carry
 * only its head (`TOOL_OUTPUT_CLIENT_CHARS`); the trace's "Show full output"
 * reads the rest here. 404 until the turn's reply is stored.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; toolCallId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: chatId, toolCallId } = await params;

    const db = createDb();
    const { copilotChatsService, chatHistoryService } = createContainer(
      db,
      await getActiveWorkspaceId(),
    );

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

    const content = await chatHistoryService.toolOutput(chatId, toolCallId);
    if (content === null) {
      return NextResponse.json({ error: 'Tool output not found' }, { status: 404 });
    }
    return NextResponse.json({ data: { toolCallId, content } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
