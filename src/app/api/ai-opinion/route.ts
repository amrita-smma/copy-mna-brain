import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * Enqueue an AI Opinion workforce run for a company. Powers the "Analyze AI
 * Opinion" / "Re-evaluate" button in the right-most pipeline column. The run
 * researches the company and writes a firm pass/fail/tentative verdict back
 * onto the company via the `save_ai_opinion` tool; the pipeline polls the
 * companies list to pick it up.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as { companyId?: string };
    if (!body.companyId) {
      return NextResponse.json(
        { error: 'Missing required field: companyId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { aiOpinionService } = createContainer(db, await getActiveWorkspaceId());
    const result = await aiOpinionService.dispatch(body.companyId, session.user.id);

    return NextResponse.json({ runId: result.runId }, { status: 202 });
  } catch (error) {
    console.error('POST ai-opinion error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Internal server error' },
      { status: 500 },
    );
  }
}
