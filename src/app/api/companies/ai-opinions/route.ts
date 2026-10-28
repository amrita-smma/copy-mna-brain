import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * The compact set of companies with an AI Opinion run in flight
 * (`ai_opinion_status = 'processing'`). The Pipeline watches it while any
 * row shows a spinner and refreshes its list once the set changes — a run
 * finished — instead of re-reading every company on a cadence. Kept live by
 * the `ai-opinion` topic of `GET /api/events`.
 *
 *   GET /api/companies/ai-opinions
 */
export async function GET() {
  try {
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    const data = await companyService.findProcessingAiOpinions();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
