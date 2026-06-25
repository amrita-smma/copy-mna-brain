import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = createDb();
    const { investmentThesisService } = createContainer(db);
    await investmentThesisService.remove(id);
    return NextResponse.json({ data: { id } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete track';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
