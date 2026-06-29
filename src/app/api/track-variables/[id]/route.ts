import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { name, unit, type, options, sortOrder } = await req.json();
    const db = createDb();
    const { trackVariableService } = createContainer(db);
    const data = await trackVariableService.update(id, {
      name,
      unit,
      type,
      options,
      sortOrder,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update track variable';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = createDb();
    const { trackVariableService } = createContainer(db);
    await trackVariableService.delete(id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete track variable';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
