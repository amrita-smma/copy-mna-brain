import { NextRequest, NextResponse, after } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { dispatcherTick } from '@/lib/workforce';

interface CancelBody {
  reason?: unknown;
}

/**
 * Cancel a workforce queue row.
 *
 * Authorization: only the row's triggered_by_user_id may cancel.
 *
 * Behavior: flips the row to a terminal `failed` state with
 * error.code='cancelled_by_user'. Idempotent — cancelling an already-terminal
 * row returns 409 (not an error per se, but signals "no transition happened").
 *
 * In-flight caveat: for rows in status='running' the WDK workflow keeps
 * executing in its own context. We accept that the agent burns through its
 * current step before noticing nothing's listening; the row is terminal at
 * the DB level immediately so the dispatcher can claim the next row.
 *
 * Kicks the dispatcher after a successful cancel so a freed slot doesn't
 * wait the cron's up-to-60s interval before the next row claims.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: CancelBody = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as CancelBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const reason =
    typeof body.reason === 'string' && body.reason.trim() ? body.reason : undefined;

  try {
    const { id } = await params;
    const db = createDb();
    const repo = new AiWorkforceQueueRepository(db);
    const item = await repo.findById(id);
    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (
      item.triggered_by_user_id &&
      item.triggered_by_user_id !== session.user.id
    ) {
      return NextResponse.json(
        { error: 'Only the task creator can cancel' },
        { status: 403 },
      );
    }

    const cancelled = await repo.cancelById(id, {
      userId: session.user.id,
      reason,
    });
    if (!cancelled) {
      return NextResponse.json(
        { error: `task is already in terminal status '${item.status}'` },
        { status: 409 },
      );
    }

    after(async () => {
      try {
        await dispatcherTick(createDb());
      } catch (err) {
        console.error('[cancel] dispatcher kick failed:', err);
      }
    });

    return NextResponse.json({ item: cancelled });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to cancel task';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
