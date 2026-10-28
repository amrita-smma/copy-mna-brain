import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/**
 * The company's AI Company Card plus its in-flight AI Workforce card run.
 *
 * `run` is non-null while a card run is queued or executing, so the Overview
 * tab can show "Generating…" with a link to the task even before the run has
 * written a `company_analyses` row, and keep showing it across a reload.
 */
export async function GET(request: NextRequest) {
  try {
    const companyId = request.nextUrl.searchParams.get('companyId');
    if (!companyId) {
      return NextResponse.json(
        { error: 'Missing required query parameter: companyId' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { companyAnalysisService } = createContainer(db, await getActiveWorkspaceId());
    const data = await companyAnalysisService.getGenerationState(companyId);
    return NextResponse.json({ data });
  } catch (error) {
    console.error('GET company-analysis/state error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
