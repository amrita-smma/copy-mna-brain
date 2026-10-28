import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  CopilotChatForbiddenError,
  CopilotChatNotFoundError,
} from '@/lib/services/copilotChatsService';
import {
  CardDecisionConflictError,
  InvalidCardDecisionError,
} from '@/lib/services/copilotChatCardService';
import { isUuid } from '@/lib/uuid';

/**
 * Record the caller's decision on an action card (an approval, a set of
 * options, a Workforce hand-off) in their chat. Body:
 * `{ toolName, status: 'accepted' | 'declined', resolutionText?, data? }`.
 * The first decision stands: when the card was already decided, that decision
 * comes back with `alreadyDecided: true` and nothing is written.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; cardId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: chatId, cardId } = await params;
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

    const db = createDb();
    const { copilotChatCardService } = createContainer(db, await getActiveWorkspaceIdOrThrow());

    try {
      const result = await copilotChatCardService.decide({
        userId: session.user.id,
        chatId,
        cardId,
        toolName: record.toolName,
        status: record.status,
        resolutionText: record.resolutionText,
        data: record.data,
      });
      return NextResponse.json({ data: result });
    } catch (err) {
      if (err instanceof InvalidCardDecisionError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof CardDecisionConflictError) {
        return NextResponse.json({ error: 'The card could not be decided. Reload and try again.' }, { status: 409 });
      }
      if (err instanceof CopilotChatNotFoundError) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      if (err instanceof CopilotChatForbiddenError) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
