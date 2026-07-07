import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    const data = await companyService.getAssignees(id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load assignees';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { userIds } = await req.json();
    if (!Array.isArray(userIds)) {
      return NextResponse.json({ error: 'userIds must be an array' }, { status: 400 });
    }
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    await companyService.setAssignees(id, userIds);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to set assignees';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
