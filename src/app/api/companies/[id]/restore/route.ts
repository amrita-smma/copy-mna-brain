import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  PipelineStageUnavailableError,
  RestoreStageRequiredError,
} from '@/lib/services/companyService';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { currentStage, targetStage } = await req.json();
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    await companyService.restoreDeal(
      id,
      currentStage,
      typeof targetStage === 'string' && targetStage ? targetStage : undefined,
    );
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    // The deal's stage was deleted while it was dropped: the client asks the
    // user for a stage and retries with `targetStage`.
    if (error instanceof RestoreStageRequiredError) {
      return NextResponse.json(
        { error: error.message, code: 'restore_stage_required', stage: error.stage },
        { status: 409 },
      );
    }
    if (error instanceof PipelineStageUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Failed to restore deal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
