import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { MNA_WORKSPACE_ID } from '@/lib/constants';
import { UnknownFeatureError } from '@/lib/services/featureFlagsService';

// Superadmin-only: backs the admin portal's Features tab. Feature overrides are
// per workspace, so the target workspace is the `[id]` route param;
// MNA_WORKSPACE_ID is used only to build the container for the superadmin check.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { workspaceService, featureFlagsService } = createContainer(db, MNA_WORKSPACE_ID);
    if (!(await workspaceService.isSuperadmin(session.user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await params;
    const data = await featureFlagsService.listFeatures(id);
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as { key?: unknown; enabled?: unknown };
    if (typeof body?.key !== 'string' || typeof body?.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'key (string) and enabled (boolean) are required' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { workspaceService, featureFlagsService } = createContainer(db, MNA_WORKSPACE_ID);
    if (!(await workspaceService.isSuperadmin(session.user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;
    const data = await featureFlagsService.setFeature(id, body.key, body.enabled, session.user.id);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof UnknownFeatureError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
