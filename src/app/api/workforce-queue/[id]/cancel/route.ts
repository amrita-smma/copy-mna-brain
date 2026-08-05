import { NextRequest, NextResponse, after } from 'next/server';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { auth } from '@/auth';
import { createDb, withBackgroundDb } from '@/lib/server/db';
import {
  AiWorkforceQueueRepository,
  RoutinesRepository,
  UserRepository,
  WorkspaceRepository,
} from '@/lib/repositories';
import { EmailNotificationService } from '@/lib/services/emailNotificationService';
import { dispatcherTick } from '@/lib/workforce';
import { failAiOpinionIfStillProcessing } from '@/lib/workforce/clearAiOpinionOnFailure';

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
    const workspaceId = await getActiveWorkspaceId();
    const repo = new AiWorkforceQueueRepository(db, workspaceId);
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

    // Scope spinner clear + notify to the *row's* workspace. The actor's
    // active workspace can differ (cross-workspace queue browse); using it
    // would miss the entity or write against the wrong tenant.
    const entityWorkspaceId = item.workspace_id ?? workspaceId;

    // Release any AI Opinion spinner left on the target entity.
    await failAiOpinionIfStillProcessing(
      db,
      entityWorkspaceId,
      item.trigger_meta,
      item.agent_name,
    );

    after(async () => {
      await withBackgroundDb(async (freshDb) => {
        try {
          await dispatcherTick(freshDb);
        } catch (err) {
          console.error('[cancel] dispatcher kick failed:', err);
        }
        // Best-effort cancellation notification (MB-90). The service no-ops when
        // the feature flag is off and swallows its own errors.
        const notifier = new EmailNotificationService({
          workforceRepo: new AiWorkforceQueueRepository(freshDb, entityWorkspaceId),
          routinesRepo: new RoutinesRepository(freshDb, entityWorkspaceId),
          userRepo: new UserRepository(freshDb),
          workspaceRepo: new WorkspaceRepository(freshDb),
        });
        await notifier.notifyTaskFailed(id, { cancelled: true, reason });
      });
    });

    return NextResponse.json({ item: cancelled });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to cancel task';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
