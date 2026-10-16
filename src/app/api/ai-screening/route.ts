import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getStatelessAgentGraph } from '@/lib/agents/analysis';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { NotPendingConfirmationError } from '@/lib/services/aiScreeningService';

/**
 * A Pending Confirmation company's Run AI Screening action: queue an AI
 * screening task on the AI Workforce — the same forced scan Scan now runs
 * (match tracks if none, screen every criterion, then auto drop/promote when
 * the workspace has it on). Screening rows of already-matched tracks are reset
 * to pending now, so the Pipeline's AI Screening tab shows it in progress.
 *
 * POST `{ companyId }` → 202 `{ data: { alreadyQueued, trackCount, screeningCount } }`,
 * 409 when the company is not active in Pending Confirmation.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as { companyId?: unknown };
    const companyId = typeof body.companyId === 'string' ? body.companyId.trim() : '';
    if (!companyId) {
      return NextResponse.json({ error: 'Missing required field: companyId' }, { status: 400 });
    }

    const db = createDb();
    const { aiScreeningService } = createContainer(db, await getActiveWorkspaceIdOrThrow());
    const data = await aiScreeningService.enqueueForCompany(companyId, session.user.id);
    return NextResponse.json({ data }, { status: 202 });
  } catch (error) {
    if (error instanceof NotPendingConfirmationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof NoActiveWorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('AI Screening error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  const agent = await getStatelessAgentGraph();
  return NextResponse.json({
    status: agent ? 'ready' : 'not_configured',
    message: agent
      ? 'AI Screening endpoint is ready'
      : 'Agent not available. Check ANTHROPIC_API_KEY.',
  });
}
