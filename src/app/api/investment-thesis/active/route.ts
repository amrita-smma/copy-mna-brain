import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/**
 * Configure the AI market scanner's active thesis ("Track") set, plus the
 * shared scan cadence and companies-per-scan. Body: `{ thesisIds, scan_frequency,
 * sources_count }`. Returns the full thesis list reflecting the new active set.
 */
export async function POST(req: NextRequest) {
  try {
    const db = createDb();
    const { investmentThesisService } = createContainer(db, await getActiveWorkspaceId());
    const body = await req.json();
    const data = await investmentThesisService.configureScan({
      thesisIds: Array.isArray(body.thesisIds) ? body.thesisIds : [],
      scan_frequency: body.scan_frequency,
      sources_count: body.sources_count,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to configure market scan';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
