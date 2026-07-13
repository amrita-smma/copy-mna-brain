import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { FundNotFoundError } from '@/lib/services/fundService';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ fundId: string }> }) {
  try {
    const { fundId } = await params;
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    
    if (fundId === 'unassigned') {
      const assets = await fundService.listUnassignedAssets();
      return NextResponse.json({
        data: {
          id: 'unassigned',
          workspace_id: await getActiveWorkspaceId(),
          name: 'Unassigned Assets',
          description: 'Assets without a fund assignment',
          vintage_year: null,
          commitment_size_amount: 0,
          base_currency: 'USD',
          status: 'active',
          called_amount: 0,
          fmv_amount: 0,
          realized_amount: 0,
          dpi: 0,
          tvpi: 0,
          irr: 0,
          metrics_computed_at: null,
          created_by: null,
          updated_by: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          assets
        }
      });
    }

    const [fund, assets] = await Promise.all([
      fundService.getFund(fundId),
      fundService.listAssets(fundId),
    ]);
    return NextResponse.json({ data: { ...fund, assets } });
  } catch (error: unknown) {
    if (error instanceof FundNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to fetch fund';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ fundId: string }> }) {
  try {
    const { fundId } = await params;
    const {
      name,
      description,
      vintageYear,
      commitmentSizeAmount,
      baseCurrency,
      status,
      calledAmount,
      fmvAmount,
      realizedAmount,
      dpi,
      tvpi,
      irr,
    } = await req.json();
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundService.updateFund(fundId, {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(vintageYear !== undefined ? { vintage_year: vintageYear } : {}),
      ...(commitmentSizeAmount !== undefined ? { commitment_size_amount: commitmentSizeAmount } : {}),
      ...(baseCurrency !== undefined ? { base_currency: baseCurrency } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(calledAmount !== undefined ? { called_amount: calledAmount } : {}),
      ...(fmvAmount !== undefined ? { fmv_amount: fmvAmount } : {}),
      ...(realizedAmount !== undefined ? { realized_amount: realizedAmount } : {}),
      ...(dpi !== undefined ? { dpi } : {}),
      ...(tvpi !== undefined ? { tvpi } : {}),
      ...(irr !== undefined ? { irr } : {}),
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof FundNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to update fund';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ fundId: string }> },
) {
  try {
    const { fundId } = await params;
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    await fundService.deleteFund(fundId);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof FundNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to delete fund';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
