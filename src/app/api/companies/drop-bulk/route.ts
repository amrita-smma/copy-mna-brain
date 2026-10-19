import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { CompanyDroppedError } from '@/lib/services/companyService';

interface DropBulkBody {
  deals?: Array<{ id?: unknown; currentStage?: unknown; reason?: unknown }>;
  reason?: unknown;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as DropBulkBody;
    const deals = Array.isArray(body.deals) ? body.deals : [];
    const normalized = deals
      .filter((d): d is { id: string; currentStage?: unknown; reason?: unknown } => typeof d?.id === 'string' && d.id.length > 0)
      .map((d) => ({
        id: d.id,
        currentStage: typeof d.currentStage === 'string' ? d.currentStage : undefined,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
      }));
    if (normalized.length === 0) {
      return NextResponse.json({ error: 'deals must be a non-empty array of { id, currentStage? }' }, { status: 400 });
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined;

    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    await companyService.dropDealMany(normalized, reason);
    return NextResponse.json({ data: { success: true, count: normalized.length } });
  } catch (error: unknown) {
    if (error instanceof CompanyDroppedError) {
      return NextResponse.json({ error: error.message, droppedIds: error.droppedIds }, { status: 409 });
    }
    console.error(error);
    const message = error instanceof Error ? error.message : 'Failed to drop deals';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
