import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { currentStage, reason, resurfaceAt } = await req.json();
    const session = await auth();
    const db = createDb();
    const { companyService } = createContainer(db);
    await companyService.dropDeal(id, currentStage, reason, {
      resurfaceAt: typeof resurfaceAt === 'string' && resurfaceAt ? resurfaceAt : null,
      droppedBy: session?.user?.id ?? null,
    });
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to drop deal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
