import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { ChatAttachmentForbiddenError } from '@/lib/services/chatAttachmentService';

/**
 * DELETE - Remove a chat attachment from S3 (user removed the chip or started
 * a new chat). Only keys under the caller's own workspace prefix are accepted.
 */
export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const key: string | undefined = body?.key;
    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 });
    }

    const db = createDb();
    const { chatAttachmentService } = createContainer(
      db,
      await getActiveWorkspaceIdOrThrow(),
    );
    await chatAttachmentService.delete(key);

    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    if (err instanceof ChatAttachmentForbiddenError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
