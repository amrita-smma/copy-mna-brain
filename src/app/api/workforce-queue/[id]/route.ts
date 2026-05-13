import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
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
    const { aiWorkforceService } = createContainer(db);
    const item = await aiWorkforceService.findById(id);
    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to load workforce task';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
