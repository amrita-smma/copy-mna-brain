import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/**
 * POST /api/graph/sync — reconcile the Neo4j relationship graph against
 * Postgres (the source of truth). Dispatches a background job and returns the
 * job id immediately (202); progress is tracked in jobs + job_logs.
 */
export async function POST() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = createDb();
    const { companyGraphService } = createContainer(db, await getActiveWorkspaceId());
    const { jobId } = await companyGraphService.dispatchSync();

    return NextResponse.json({ data: { jobId } }, { status: 202 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
