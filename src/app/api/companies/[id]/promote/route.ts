import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';
import { CompanyDroppedError, CompanyL0RequirementsError } from '@/lib/services/companyService';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { currentStage, nextStage, note, linkUrl, linkTitle, assigneeIds, promotionReason, hasDocument } =
      await req.json();
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    // Attributes the server-side `deal_promoted`/`deal_demoted` capture to the
    // user who made the move rather than to 'server'.
    const session = await auth();
    await companyService.promote(
      id,
      currentStage,
      nextStage,
      note,
      linkUrl,
      linkTitle,
      assigneeIds,
      promotionReason,
      { triggeredByUserId: session?.user?.id ?? null, hasDocument: Boolean(hasDocument) },
    );
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof CompanyL0RequirementsError) {
      return NextResponse.json(
        { error: error.message, missingFields: error.missingFields },
        { status: 422 },
      );
    }
    if (error instanceof CompanyDroppedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Failed to promote company';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
