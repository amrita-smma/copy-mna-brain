import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';
import { CompanyDroppedError, PipelineStageUnavailableError } from '@/lib/services/companyService';

interface PromoteBulkBody {
  deals?: Array<{ id?: unknown; currentStage?: unknown }>;
  nextStage?: unknown;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PromoteBulkBody;
    const deals = Array.isArray(body.deals) ? body.deals : [];
    const normalized = deals
      .filter((d): d is { id: string; currentStage?: unknown } => typeof d?.id === 'string' && d.id.length > 0)
      .map((d) => ({
        id: d.id,
        currentStage: typeof d.currentStage === 'string' ? d.currentStage : undefined,
      }));
    if (normalized.length === 0) {
      return NextResponse.json({ error: 'deals must be a non-empty array of { id, currentStage? }' }, { status: 400 });
    }
    if (typeof body.nextStage !== 'string' || body.nextStage.length === 0) {
      return NextResponse.json({ error: 'nextStage is required' }, { status: 400 });
    }

    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    // Attributes the server-side `deal_promoted`/`deal_demoted` captures to the
    // user who ran the bulk move rather than to 'server'.
    const session = await auth();
    await companyService.promoteMany(normalized, body.nextStage, session?.user?.id ?? null);
    return NextResponse.json({ data: { success: true, count: normalized.length } });
  } catch (error: unknown) {
    if (error instanceof CompanyDroppedError) {
      return NextResponse.json({ error: error.message, droppedIds: error.droppedIds }, { status: 409 });
    }
    if (error instanceof PipelineStageUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error(error);
    const message = error instanceof Error ? error.message : 'Failed to promote deals';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
