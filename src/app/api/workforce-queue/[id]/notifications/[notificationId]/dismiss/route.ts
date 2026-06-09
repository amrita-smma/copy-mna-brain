import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; notificationId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id, notificationId } = await params;
    const db = createDb();
    const { aiWorkforceService, notificationService } = createContainer(db);

    const item = await aiWorkforceService.findById(id);
    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (
      item.triggered_by_user_id &&
      item.triggered_by_user_id !== session.user.id
    ) {
      return NextResponse.json(
        { error: 'Only the task creator can dismiss notifications' },
        { status: 403 },
      );
    }

    await notificationService.dismiss(id, notificationId);
    const notifications = await notificationService.list(id);
    return NextResponse.json({ data: { notifications } });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to dismiss notification';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
