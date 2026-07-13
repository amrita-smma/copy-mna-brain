import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { FundSourceNotFoundError } from '@/lib/services/fundSourceService';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  try {
    const { sourceId } = await params;
    const {
      name,
      investedAmount,
      realizedAmount,
      fmvAmount,
      dpi,
      moic,
      irr,
      metricsComputedAt,
    } = await req.json();
    const db = createDb();
    const { fundSourceService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundSourceService.updateFundSource(sourceId, {
      ...(name !== undefined ? { name } : {}),
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
    if (error instanceof FundSourceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to update fund source';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  try {
    const { sourceId } = await params;
    const db = createDb();
    const { fundSourceService } = createContainer(db, await getActiveWorkspaceId());
    await fundSourceService.deleteFundSource(sourceId);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof FundSourceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to delete fund source';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
