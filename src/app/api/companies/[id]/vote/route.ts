import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { VoteRuleError } from '@/lib/services/companyVoteService';

/** Map a domain rule violation onto its HTTP status; anything else is a 500. */
function errorResponse(err: unknown, fallback: string): NextResponse {
  if (err instanceof VoteRuleError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

/** The Voting tab's whole payload for the signed-in user. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const db = createDb();
    const { companyVoteService } = createContainer(db, await getActiveWorkspaceId());
    const data = await companyVoteService.getState(id, session.user.id);
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err, 'Failed to load the voting round');
  }
}

/** Start a new voting round on this company. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const body = await req.json();
    if (!Array.isArray(body?.voterIds)) {
      return NextResponse.json({ error: 'voterIds must be an array' }, { status: 400 });
    }
    if (typeof body?.deadlineAt !== 'string' || !body.deadlineAt.trim()) {
      return NextResponse.json(
        { error: 'deadlineAt must be an ISO date-time string' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { companyVoteService } = createContainer(db, await getActiveWorkspaceId());
    const { invitationsQueued } = await companyVoteService.startVote({
      companyId: id,
      initiatorId: session.user.id,
      voterIds: body.voterIds,
      deadlineAt: body.deadlineAt,
    });
    const data = await companyVoteService.getState(id, session.user.id);
    // The round stands either way, but a swallowed notification failure must
    // not look like success — otherwise "I never got the email" has no signal.
    return NextResponse.json({
      data: {
        ...data,
        notice: invitationsQueued
          ? null
          : 'The vote is open, but the invitation emails could not be queued. Check the server logs.',
      },
    });
  } catch (err) {
    return errorResponse(err, 'Failed to start the vote');
  }
}

/**
 * Initiator-only round actions:
 *  - `cancel`    — abandon the round
 *  - `send_back` — reopen every submitted ballot for revision
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const body = await req.json();
    const action = body?.action;
    if (action !== 'cancel' && action !== 'send_back') {
      return NextResponse.json(
        { error: 'action must be "cancel" or "send_back"' },
        { status: 400 },
      );
    }
    if (typeof body?.sessionId !== 'string' || !body.sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const db = createDb();
    const { companyVoteService } = createContainer(db, await getActiveWorkspaceId());
    if (action === 'cancel') {
      await companyVoteService.cancelVote(body.sessionId, session.user.id, id);
    } else {
      await companyVoteService.sendBackSubmissions(body.sessionId, session.user.id, id);
    }
    const data = await companyVoteService.getState(id, session.user.id);
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err, 'Failed to update the voting round');
  }
}
