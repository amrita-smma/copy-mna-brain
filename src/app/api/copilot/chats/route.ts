import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/** Parse a non-negative integer query param, falling back when absent/garbage. */
function intParam(value: string | null, fallback: number | undefined) {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const params = req.nextUrl.searchParams;
    const db = createDb();
    const { copilotChatsService } = createContainer(db, await getActiveWorkspaceId());
    // `chats` stays a top-level key: the sidebar has read it since before this
    // endpoint was paged, and older clients keep working (they just see page 1).
    const { chats, hasMore, nextOffset } = await copilotChatsService.list(
      session.user.id,
      {
        limit: intParam(params.get('limit'), undefined),
        offset: intParam(params.get('offset'), 0),
      },
    );
    return NextResponse.json({ chats, hasMore, nextOffset });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = createDb();
  const { copilotChatsService } = createContainer(db, await getActiveWorkspaceId());
  const chat = await copilotChatsService.create(session.user.id);
  return NextResponse.json({ chat }, { status: 201 });
}
