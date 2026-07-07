import { NextRequest, NextResponse, after } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import {
  TaskBusyError,
  TaskNotFoundError,
  TaskOwnershipError,
} from '@/lib/services/aiWorkforceService';
import { dispatcherTick } from '@/lib/workforce';

interface MessageBody {
  text?: unknown;
}

const MAX_TEXT_LEN = 4000;

/**
 * Submit a free-form user update against a workforce run.
 *
 * Authorization: only the row's triggered_by_user_id may submit.
 *
 * Behavior:
 *   - For paused/queued rows (pending / waiting_for_human_input /
 *     resume_ready): append to the row's pending_user_messages buffer.
 *     runAgent consumes the buffer on next invoke/resume.
 *   - For terminal rows (succeeded / failed / rejected / timed_out): spawn
 *     a fresh workforce row that resumes the original LangGraph thread.
 *   - For thinking rows (running / waiting_for_subagent): 409. The UI
 *     should prevent this; this is the server backstop.
 *
 * After a successful submit we fire-and-forget kick the dispatcher so any
 * row that just transitioned to resume_ready (or the freshly-forked
 * pending row) claims a slot without waiting for the cron tick.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: MessageBody = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as MessageBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LEN) {
    return NextResponse.json(
      { error: `text exceeds ${MAX_TEXT_LEN} characters` },
      { status: 400 },
    );
  }

  try {
    const { id } = await params;
    const db = createDb();
    const { aiWorkforceService } = createContainer(db, await getActiveWorkspaceId());
    const result = await aiWorkforceService.submitUserMessage({
      runId: id,
      userId: session.user.id,
      text,
    });

    after(async () => {
      try {
        await dispatcherTick(createDb());
      } catch (err) {
        console.error('[message] dispatcher kick failed:', err);
      }
    });

    return NextResponse.json({ data: result });
  } catch (err: unknown) {
    if (err instanceof TaskNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (err instanceof TaskOwnershipError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof TaskBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
