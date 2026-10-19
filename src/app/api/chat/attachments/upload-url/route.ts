import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';

/**
 * GET - Mint a presigned PUT URL so the browser can upload a chat attachment
 * directly to S3 under the workspace-scoped `chat-attachments/` prefix. The
 * returned key is what the client sends back with its chat message.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const fileName = req.nextUrl.searchParams.get('fileName');
    const contentType =
      req.nextUrl.searchParams.get('contentType') || 'application/octet-stream';
    if (!fileName) {
      return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
    }

    const db = createDb();
    const { chatAttachmentService } = createContainer(
      db,
      await getActiveWorkspaceIdOrThrow(),
    );
    const target = await chatAttachmentService.createUploadTarget(fileName, contentType);

    return NextResponse.json({ data: target });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
