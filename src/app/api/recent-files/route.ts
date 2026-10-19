import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const page = Number(req.nextUrl.searchParams.get('page') ?? '1');

    const db = createDb();
    const { recentFileService } = createContainer(db, await getActiveWorkspaceId());
    const data = await recentFileService.listRecent(session.user.id, page);

    return NextResponse.json({ data });
  } catch (err) {
    console.error('GET recent-files error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
    const fileKey = typeof body?.fileKey === 'string' ? body.fileKey.trim() : '';

    if (!fileName || !fileKey) {
      return NextResponse.json(
        { error: 'fileName and fileKey are required' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { recentFileService } = createContainer(db, await getActiveWorkspaceId());
    await recentFileService.recordOpen(session.user.id, fileName, fileKey);

    return NextResponse.json({ data: { success: true } });
  } catch (err) {
    console.error('POST recent-files error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
