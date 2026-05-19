import { NextRequest, NextResponse, after } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { dispatcherTick } from '@/lib/workforce';
import type { HumanDecision } from '@/lib/db/schema';

interface DecisionRequestBody {
  tool_call_id?: unknown;
  tool_name?: unknown;
  decision?: unknown;
  rejection_message?: unknown;
}

function parseBody(raw: unknown): {
  tool_call_id: string;
  tool_name: string;
  decision: 'approve' | 'reject';
  rejection_message?: string;
} | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'invalid body' };
  const b = raw as DecisionRequestBody;
  if (typeof b.tool_call_id !== 'string' || !b.tool_call_id) {
    return { error: 'tool_call_id is required' };
  }
  if (typeof b.tool_name !== 'string' || !b.tool_name) {
    return { error: 'tool_name is required' };
  }
  if (b.decision !== 'approve' && b.decision !== 'reject') {
    return { error: "decision must be 'approve' or 'reject'" };
  }
  const out: ReturnType<typeof parseBody> = {
    tool_call_id: b.tool_call_id,
    tool_name: b.tool_name,
    decision: b.decision,
  };
  if (b.decision === 'reject') {
    if (typeof b.rejection_message === 'string' && b.rejection_message.trim()) {
      (out as { rejection_message?: string }).rejection_message =
        b.rejection_message;
    }
  }
  return out;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parsed = parseBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const { id } = await params;
    const db = createDb();
    const { aiWorkforceService } = createContainer(db);
    const item = await aiWorkforceService.findById(id);
    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (item.triggered_by_user_id !== session.user.id) {
      return NextResponse.json(
        { error: 'Only the task creator can decide' },
        { status: 403 },
      );
    }
    if (item.status !== 'waiting_for_human_input') {
      return NextResponse.json(
        { error: `task is in status '${item.status}', not waiting for input` },
        { status: 409 },
      );
    }

    const resumePayload =
      parsed.decision === 'approve'
        ? { decisions: [{ type: 'approve' as const }] }
        : {
            decisions: [
              {
                type: 'reject' as const,
                message: parsed.rejection_message,
              },
            ],
          };

    // Audit the decision and queue the resume. The dispatcher claims the row
    // (advisory lock + serial guard), starts a WDK workflow, and runAgent
    // calls graph.resume with the stashed payload. This keeps the "1 active
    // run at a time" cap honest — the resume goes through the same gating as
    // a fresh dispatch.
    const repo = new AiWorkforceQueueRepository(db);
    const auditEntry: HumanDecision = {
      tool_call_id: parsed.tool_call_id,
      tool_name: parsed.tool_name,
      decision: parsed.decision,
      decided_at: new Date().toISOString(),
      ...(parsed.decision === 'reject' && parsed.rejection_message
        ? { rejection_message: parsed.rejection_message }
        : {}),
    };
    await repo.appendDecision(item.id, auditEntry);

    const reason = `human ${parsed.decision}`;
    await repo.markResumeReady(item.id, reason, JSON.stringify(resumePayload));

    // Fire-and-forget dispatcher kick so the resume claims the slot
    // immediately when free. The cron tick remains the liveness fallback.
    after(async () => {
      try {
        await dispatcherTick(createDb());
      } catch (err) {
        console.error('[decision] dispatcher kick failed:', err);
      }
    });

    return NextResponse.json({ status: 'queued_for_resume' });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to record decision';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
