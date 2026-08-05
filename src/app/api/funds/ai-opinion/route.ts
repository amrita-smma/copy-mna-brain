import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * Enqueue a Fund AI Opinion workforce run for a fund holding (MB-470). Powers
 * the "Analyze AI Opinion" / "Re-evaluate" button in the right-most Fund
 * Management Asset table column. The run reviews the holding's inlined
 * metrics and writes a firm buy/hold/sell verdict back onto the fund asset
 * via the `save_fund_ai_opinion` tool; the portfolio poll picks it up.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as { fundAssetId?: string };
    if (!body.fundAssetId) {
      return NextResponse.json(
        { error: 'Missing required field: fundAssetId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { fundAiOpinionService } = createContainer(db, await getActiveWorkspaceId());
    const result = await fundAiOpinionService.dispatch(body.fundAssetId, session.user.id);

    return NextResponse.json({ data: { runId: result.runId } }, { status: 202 });
  } catch (error) {
    console.error('POST funds/ai-opinion error:', error);
    const message = error instanceof Error ? error.message : '';
    if (/No fund asset found/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
