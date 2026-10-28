import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * The newest `ai_screening` AI Workforce task of every active Pending
 * Confirmation and L0 company — what the Pipeline's AI Screening panel shows
 * beside each row ("queued" / "running", which the `screenings` rows alone
 * cannot tell). Kept live by the `workforce` topic of `GET /api/events`.
 *
 *   GET /api/ai-screening/tasks
 */
export async function GET() {
  try {
    const db = createDb();
    const { aiScreeningService } = createContainer(db, await getActiveWorkspaceId());
    const data = await aiScreeningService.listCompanyTasks();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
