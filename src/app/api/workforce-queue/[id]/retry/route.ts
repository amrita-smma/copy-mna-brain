import { NextRequest, NextResponse, after } from 'next/server';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { dispatcherTick } from '@/lib/workforce';

/**
 * Retry a terminal-failure workforce queue row.
 *
 * Authorization: only the original row's triggered_by_user_id may retry.
 *
 * Allowed statuses: failed, rejected, timed_out. Retrying a succeeded row is
 * a different operation (re-run) and out of scope here.
 *
 * Inserts a fresh `pending` row carrying retried_from_id back to the original.
 * The original stays terminal — debugging history is preserved. The new row
 * drops into the dispatcher's regular claim flow on the next tick.
 */
const RETRYABLE_STATUSES = ['failed', 'rejected', 'timed_out'] as const;
type RetryableStatus = (typeof RETRYABLE_STATUSES)[number];

function isRetryable(status: string): status is RetryableStatus {
  return (RETRYABLE_STATUSES as readonly string[]).includes(status);
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const db = createDb();
    const repo = new AiWorkforceQueueRepository(db, await getActiveWorkspaceId());
    const original = await repo.findById(id);
    if (!original) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (
      original.triggered_by_user_id &&
      original.triggered_by_user_id !== session.user.id
    ) {
      return NextResponse.json(
        { error: 'Only the task creator can retry' },
        { status: 403 },
      );
    }
    if (!isRetryable(original.status)) {
      return NextResponse.json(
        {
          error: `task in status '${original.status}' cannot be retried (must be failed, rejected, or timed_out)`,
        },
        { status: 409 },
      );
    }

    const fresh = await repo.retryById(id, { userId: session.user.id });

    after(async () => {
      try {
        await dispatcherTick(createDb());
      } catch (err) {
        console.error('[retry] dispatcher kick failed:', err);
      }
    });

    return NextResponse.json({ item: fresh });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to retry task';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
