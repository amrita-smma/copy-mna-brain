import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { CompanyDroppedError, CompanyL0RequirementsError } from '@/lib/services/companyService';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { currentStage, nextStage, note, linkUrl, linkTitle, assigneeIds, promotionReason } = await req.json();
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    await companyService.promote(id, currentStage, nextStage, note, linkUrl, linkTitle, assigneeIds, promotionReason);
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
