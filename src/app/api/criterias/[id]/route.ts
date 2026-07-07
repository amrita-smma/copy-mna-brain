import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { name, prompt } = await req.json();
    const db = createDb();
    const { criteriaService } = createContainer(db, await getActiveWorkspaceId());
    const data = await criteriaService.update(id, name, prompt);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update criteria';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = createDb();
    const { criteriaService } = createContainer(db, await getActiveWorkspaceId());
    await criteriaService.delete(id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete criteria';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
