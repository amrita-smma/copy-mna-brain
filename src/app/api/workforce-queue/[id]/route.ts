import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const db = createDb();
    const workspaceId = await getActiveWorkspaceId();
    const { aiWorkforceService, insightService } = createContainer(db, workspaceId);
    const item = await aiWorkforceService.findById(id);
    // findById is unscoped (shared with system-internal callers) — enforce
    // workspace ownership here, at the user-facing edge. 404 rather than 403
    // so a cross-workspace id doesn't reveal that the task exists at all.
    if (!item || item.workspace_id !== workspaceId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    // Opening a failed task is what clears it from the owner's red "unseen
    // failures" count on the Workforce nav item.
    await aiWorkforceService.markFailureSeen(item, session.user.id);
    // The insight version this run produced, for the task header's link to
    // it. A field on this response (one indexed lookup by source_run_id)
    // rather than a new endpoint: TaskCanvas already fetches and polls it.
    const insightVersion =
      (await insightService.findVersionForRun(item.workspace_id, id)) ?? null;
    return NextResponse.json({ item, insight_version: insightVersion });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to load workforce task';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
