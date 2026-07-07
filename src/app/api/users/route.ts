import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET() {
  try {
    const db = createDb();
    const { userService } = createContainer(db, await getActiveWorkspaceId());
    const data = await userService.list();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to list users';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
