import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { VoteRuleError } from '@/lib/services/companyVoteService';

/**
 * Save the signed-in user's ballot as a draft, or submit it.
 *
 * `submit: true` locks the ballot — after that only the initiator's "send back
 * submissions" can reopen it. A body with `choice`/`bodyHtml` omitted leaves
 * that field untouched, so "save the rationale" and "pick a choice" are
 * independent round trips.
 */
export async function PUT(
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
    if (typeof body?.sessionId !== 'string' || !body.sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const db = createDb();
    const { companyVoteService } = createContainer(db, await getActiveWorkspaceId());
    await companyVoteService.saveBallot({
      sessionId: body.sessionId,
      voterId: session.user.id,
      // Binds the body's sessionId to the company in the URL — see
      // CompanyVoteService.requireSession.
      companyId: id,
      choice: body.choice,
      bodyHtml: body.bodyHtml,
      submit: body.submit === true,
    });
    const data = await companyVoteService.getState(id, session.user.id);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof VoteRuleError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: 'Failed to save the ballot' }, { status: 500 });
  }
}
