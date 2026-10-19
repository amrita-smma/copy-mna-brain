import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { copilotMemoryEnabled } from '@/lib/flags';

/**
 * What the CoPilot remembers about the signed-in user — the Profile → Memory
 * tab. Not workspace-scoped: a memory belongs to the person.
 *
 * Always scoped to the session user: there is no `userId` param, so one member
 * cannot read another's memories. `?limit=` caps the page (default 50, max 200)
 * and `?offset=` pages through it.
 *
 * `available` is the deployment kill-switch; `enabled` is the user's own
 * preference. They are separate so the tab can tell "an admin switched this
 * off" from "you switched this off" — the second still lists what was learned
 * before, with the toggle showing why nothing new is arriving.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workspaceId = await getActiveWorkspaceId();
    if (!(await copilotMemoryEnabled()) || !workspaceId) {
      return NextResponse.json({
        data: { items: [], total: 0, hasMore: false, available: false, enabled: false },
      });
    }

    const limitParam = req.nextUrl.searchParams.get('limit');
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (limit !== undefined && !Number.isFinite(limit)) {
      return NextResponse.json({ error: 'Invalid limit param' }, { status: 400 });
    }

    const offsetParam = req.nextUrl.searchParams.get('offset');
    const offset = offsetParam === null ? undefined : Number(offsetParam);
    if (offset !== undefined && !Number.isFinite(offset)) {
      return NextResponse.json({ error: 'Invalid offset param' }, { status: 400 });
    }

    const db = createDb();
    const { userMemoryService } = createContainer(db, workspaceId);
    const memory = userMemoryService(userId);
    const [{ items, total, hasMore }, enabled] = await Promise.all([
      memory.list(limit, offset),
      memory.preference(),
    ]);

    return NextResponse.json({
      data: { items, total, hasMore, available: memory.available(), enabled },
    });
  } catch (err) {
    console.error('[GET /api/profile/memories]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Turn the CoPilot's memory of this user on or off.
 *
 * A per-user setting, so there is no `userId` in the body either — it comes
 * from the session. Switching it off stops recall and the write-back but keeps
 * what was already learned; DELETE below is how you remove that.
 */
export async function PATCH(req: NextRequest) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workspaceId = await getActiveWorkspaceId();
    if (!workspaceId) {
      return NextResponse.json({ error: 'No active workspace' }, { status: 400 });
    }

    const body = await req.json();
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    const db = createDb();
    const { userMemoryService } = createContainer(db, workspaceId);
    const enabled = await userMemoryService(userId).setPreference(body.enabled);

    return NextResponse.json({ data: { enabled } });
  } catch (err) {
    console.error('[PATCH /api/profile/memories]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Forget everything the CoPilot remembers about this user.
 *
 * Deliberately NOT gated on `copilotMemoryEnabled`, unlike GET and the import.
 * Turning the deployment switch off must not strand a user's data: whatever was
 * learned while it was on stays in the table, and the one thing they should
 * always be able to do with their own memories is delete them. The scope is
 * unchanged — the service only ever touches the session user's rows — so an
 * ungated DELETE grants no reach a gated one would not.
 */
export async function DELETE() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workspaceId = await getActiveWorkspaceId();
    if (!workspaceId) {
      return NextResponse.json({ error: 'No active workspace' }, { status: 400 });
    }

    const db = createDb();
    const { userMemoryService } = createContainer(db, workspaceId);
    const deleted = await userMemoryService(userId).forgetAll();

    return NextResponse.json({ data: { deleted } });
  } catch (err) {
    console.error('[DELETE /api/profile/memories]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
