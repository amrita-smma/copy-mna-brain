import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  MAX_FEEDBACK_MESSAGE_LENGTH,
  MAX_FEEDBACK_TITLE_LENGTH,
  normalizeFeedbackTitle,
} from '@/lib/services/feedbackService';

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const title =
      typeof record.title === 'string' ? normalizeFeedbackTitle(record.title) : '';
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    if (!title) {
      return NextResponse.json(
        { error: 'Missing required field: title' },
        { status: 400 },
      );
    }
    if (title.length > MAX_FEEDBACK_TITLE_LENGTH) {
      return NextResponse.json(
        { error: `title must be ${MAX_FEEDBACK_TITLE_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }
    if (!message) {
      return NextResponse.json(
        { error: 'Missing required field: message' },
        { status: 400 },
      );
    }
    if (message.length > MAX_FEEDBACK_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: `message must be ${MAX_FEEDBACK_MESSAGE_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }

    const db = createDb();
    const { feedbackService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await feedbackService.submit({
      userId: session.user.id,
      title,
      message,
    });

    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('POST feedback error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
