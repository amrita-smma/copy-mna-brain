import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = createDb();
    const { jobService } = createContainer(db, await getActiveWorkspaceId());
    const job = await jobService.findByIdWithLogs(id);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load job';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
