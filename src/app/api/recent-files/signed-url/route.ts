import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const key = req.nextUrl.searchParams.get('key');
    const name = req.nextUrl.searchParams.get('name') ?? undefined;
    if (!key) {
      return NextResponse.json({ error: 'key query parameter is required' }, { status: 400 });
    }

    const db = createDb();
    const { recentFileService } = createContainer(db, await getActiveWorkspaceId());
    const [url, downloadUrl] = await Promise.all([
      recentFileService.resolveSignedUrl(key),
      recentFileService.resolveDownloadUrl(key, name || key.split('/').pop() || 'download'),
    ]);

    return NextResponse.json({ data: { url, downloadUrl } });
  } catch (err) {
    console.error('GET recent-files/signed-url error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
