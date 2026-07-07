import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

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
    const { aiWorkforceService } = createContainer(db, workspaceId);
    const item = await aiWorkforceService.findById(id);
    // findById is unscoped (shared with system-internal callers) — enforce
    // workspace ownership here, at the user-facing edge. 404 rather than 403
    // so a cross-workspace id doesn't reveal that the task exists at all.
    if (!item || item.workspace_id !== workspaceId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to load workforce task';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
