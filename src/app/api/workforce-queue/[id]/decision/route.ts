import { NextRequest, NextResponse, after } from 'next/server';
import { auth } from '@/auth';
import { createDb, withBackgroundDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { dispatcherTick } from '@/lib/workforce';
import type { HumanDecision, PendingIntervention } from '@/lib/db/schema';
import {
  buildResumeDecision,
  type ApiDecision,
} from '@/lib/agents/analysis/hitl';

interface DecisionRequestBody {
  tool_call_id?: unknown;
  tool_name?: unknown;
  decision?: unknown;
  rejection_message?: unknown;
  answer?: unknown;
}

const API_DECISIONS: readonly ApiDecision[] = ['approve', 'answer', 'reject'];

// Shape-only validation. Whether the decision is allowed for the paused tool
// is decided by buildResumeDecision against the row's stored tool name.
function parseBody(raw: unknown): {
  tool_call_id: string;
  tool_name: string;
  decision: ApiDecision;
  rejection_message?: string;
  answer?: string;
} | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'invalid body' };
  const b = raw as DecisionRequestBody;
  if (typeof b.tool_call_id !== 'string' || !b.tool_call_id) {
    return { error: 'tool_call_id is required' };
  }
  if (typeof b.tool_name !== 'string' || !b.tool_name) {
    return { error: 'tool_name is required' };
  }
  if (!API_DECISIONS.includes(b.decision as ApiDecision)) {
    return { error: "decision must be 'approve', 'answer' or 'reject'" };
  }
  const decision = b.decision as ApiDecision;
  const out: ReturnType<typeof parseBody> = {
    tool_call_id: b.tool_call_id,
    tool_name: b.tool_name,
    decision,
  };
  if (decision === 'reject') {
    if (typeof b.rejection_message === 'string' && b.rejection_message.trim()) {
      (out as { rejection_message?: string }).rejection_message =
        b.rejection_message;
    }
  }
  if (decision === 'answer') {
    if (typeof b.answer !== 'string' || !b.answer.trim()) {
      return { error: 'answer is required' };
    }
    (out as { answer?: string }).answer = b.answer.trim();
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
    const { aiWorkforceService } = createContainer(db, await getActiveWorkspaceId());
    const item = await aiWorkforceService.findById(id);
    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    // The task creator may always decide; so may the user the intervention
    // was addressed to (e.g. the insight owner on a scheduled refresh, which
    // has no creator).
    const pending = (item.pending_intervention ?? null) as PendingIntervention | null;
    const isCreator = item.triggered_by_user_id === session.user.id;
    const isAsked = pending?.asked_user_id === session.user.id;
    if (!isCreator && !isAsked) {
      return NextResponse.json(
        { error: 'Only the task creator or the person asked can decide' },
        { status: 403 },
      );
    }
    if (item.status !== 'waiting_for_human_input') {
      return NextResponse.json(
        { error: `task is in status '${item.status}', not waiting for input` },
        { status: 409 },
      );
    }

    // Validate against the tool the run is actually paused on. Rows paused
    // before pending_intervention existed fall back to the body's tool_name
    // (ask_owner post-dates the column, so that only covers approve/reject).
    const pausedToolName = pending?.tool_name || parsed.tool_name;
    if (pending?.tool_name && parsed.tool_name !== pending.tool_name) {
      return NextResponse.json(
        { error: `task is paused on ${pending.tool_name}, not ${parsed.tool_name}` },
        { status: 409 },
      );
    }
    const built = buildResumeDecision({
      toolName: pausedToolName,
      decision: parsed.decision,
      storedArgs: pending?.tool_args,
      answer: parsed.answer,
      rejectionMessage: parsed.rejection_message,
    });
    if ('error' in built) {
      return NextResponse.json({ error: built.error }, { status: 400 });
    }
    const resumePayload = { decisions: [built.decision] };

    // Audit the decision and queue the resume. The dispatcher claims the row
    // (advisory lock + serial guard), starts a WDK workflow, and runAgent
    // calls graph.resume with the stashed payload. This keeps the "1 active
    // run at a time" cap honest — the resume goes through the same gating as
    // a fresh dispatch.
    const repo = new AiWorkforceQueueRepository(db, await getActiveWorkspaceId());
    const auditEntry: HumanDecision = {
      tool_call_id: parsed.tool_call_id,
      tool_name: pausedToolName,
      // 'answer' is an edit of the agent's proposal; accepting the
      // recommendation stays an approve in the audit even though the
      // middleware receives an edit.
      decision: parsed.decision === 'answer' ? 'edit' : parsed.decision,
      decided_at: new Date().toISOString(),
      decided_by_user_id: session.user.id,
      ...(parsed.decision === 'reject' && parsed.rejection_message
        ? { rejection_message: parsed.rejection_message }
        : {}),
      ...(built.question ? { question: built.question } : {}),
      ...(built.answer ? { answer: built.answer } : {}),
    };
    // Queue the resume first, guarded on the row still waiting: two people
    // may decide now (creator and the person asked), and only the first
    // decision may resume the run or land in the audit.
    const reason = `human ${parsed.decision}`;
    const queued = await repo.markResumeReadyFromWaiting(
      item.id,
      reason,
      JSON.stringify(resumePayload),
    );
    if (!queued) {
      return NextResponse.json(
        { error: 'this intervention was already decided' },
        { status: 409 },
      );
    }
    await repo.appendDecision(item.id, auditEntry);

    // Fire-and-forget dispatcher kick so the resume claims the slot
    // immediately when free. The cron tick remains the liveness fallback.
    after(async () => {
      try {
        await withBackgroundDb(db => dispatcherTick(db));
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
