import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = createDb();
  const { copilotChatsService } = createContainer(db);
  const chats = await copilotChatsService.list(session.user.id);
  return NextResponse.json({ chats });
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = createDb();
  const { copilotChatsService } = createContainer(db);
  const chat = await copilotChatsService.create(session.user.id);
  return NextResponse.json({ chat }, { status: 201 });
}
