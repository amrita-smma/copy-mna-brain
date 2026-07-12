import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';

export async function PATCH(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { nodeId, sizeOverride } = body as { nodeId?: string; sizeOverride?: number | null };

    if (!nodeId) {
      return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
    }
    if (sizeOverride !== null && sizeOverride !== undefined) {
      if (typeof sizeOverride !== 'number' || sizeOverride < 1 || sizeOverride > 5) {
        return NextResponse.json(
          { error: 'sizeOverride must be a number between 1 and 5' },
          { status: 400 },
        );
      }
    }

    const db = createDb();
    const { companyGraphService } = createContainer(db, await getActiveWorkspaceId());
    await companyGraphService.setNodeSizeOverride(nodeId, sizeOverride ?? null);

    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
