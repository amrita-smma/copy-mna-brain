import { after, NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  CopilotChatForbiddenError,
  CopilotChatNotFoundError,
} from '@/lib/services/copilotChatsService';
import {
  InvalidResponseFeedbackError,
  ResponseFeedbackTurnNotFoundError,
} from '@/lib/services/copilotResponseFeedbackService';
import { toResponseFeedbackValue } from '@/lib/chat/responseFeedback';
import { isUuid } from '@/lib/uuid';

/**
 * Record the caller's feedback on one reply in their chat (MB-693), replacing
 * any they already left on it. Body: `{ messageId, rating, reasons, comment }`
 * — `messageId` is the reply's `metadata.questionId`. The vote is copied to the
 * turn's Langfuse trace after the response, so the request never waits on it.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: chatId } = await params;
    // Not a uuid: no such chat (and Postgres would reject the comparison).
    if (!isUuid(chatId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const messageId = typeof record.messageId === 'string' ? record.messageId : '';
    if (!isUuid(messageId)) {
      return NextResponse.json({ error: 'messageId must be a uuid' }, { status: 400 });
    }

    const db = createDb();
    const { copilotResponseFeedbackService } = createContainer(
      db,
      await getActiveWorkspaceIdOrThrow(),
    );

    let row;
    try {
      row = await copilotResponseFeedbackService.submit({
        userId: session.user.id,
        chatId,
        messageId,
        rating: record.rating,
        reasons: record.reasons,
        comment: record.comment,
      });
    } catch (err) {
      if (err instanceof InvalidResponseFeedbackError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof CopilotChatNotFoundError || err instanceof ResponseFeedbackTurnNotFoundError) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      if (err instanceof CopilotChatForbiddenError) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      throw err;
    }

    const stored = row;
    after(() => copilotResponseFeedbackService.scoreInLangfuse(stored));

    return NextResponse.json({ data: toResponseFeedbackValue(row) });
  } catch (err) {
    if (err instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
