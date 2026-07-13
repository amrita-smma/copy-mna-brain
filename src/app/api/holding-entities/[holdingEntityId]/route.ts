import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { HoldingEntityNotFoundError } from '@/lib/services/holdingEntityService';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ holdingEntityId: string }> },
) {
  try {
    const { holdingEntityId } = await params;
    const {
      name,
      holdingEntityType,
      investedAmount,
      realizedAmount,
      fmvAmount,
      dpi,
      moic,
      irr,
      metricsComputedAt,
    } = await req.json();
    const db = createDb();
    const { holdingEntityService } = createContainer(db, await getActiveWorkspaceId());
    const data = await holdingEntityService.updateHoldingEntity(holdingEntityId, {
      ...(name !== undefined ? { name } : {}),
      ...(holdingEntityType !== undefined ? { entity_type: holdingEntityType } : {}),
      ...(investedAmount !== undefined ? { invested_amount: investedAmount } : {}),
      ...(realizedAmount !== undefined ? { realized_amount: realizedAmount } : {}),
      ...(fmvAmount !== undefined ? { fmv_amount: fmvAmount } : {}),
      ...(dpi !== undefined ? { dpi } : {}),
      ...(moic !== undefined ? { moic } : {}),
      ...(irr !== undefined ? { irr } : {}),
      ...(metricsComputedAt !== undefined ? { metrics_computed_at: metricsComputedAt } : {}),
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof HoldingEntityNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to update holding entity';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ holdingEntityId: string }> },
) {
  try {
    const { holdingEntityId } = await params;
    const db = createDb();
    const { holdingEntityService } = createContainer(db, await getActiveWorkspaceId());
    await holdingEntityService.deleteHoldingEntity(holdingEntityId);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof HoldingEntityNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to delete holding entity';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
