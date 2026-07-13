import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET() {
  try {
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundService.listFunds();
    
    const unassignedAssets = await fundService.listUnassignedAssets();
    if (unassignedAssets.length > 0) {
      data.push({
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
      } as any); // Type assertion needed because it's a mock fund
    }
    
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch funds';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
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
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundService.createFund({
      name,
      description,
      vintage_year: vintageYear,
      commitment_size_amount: commitmentSizeAmount,
      base_currency: baseCurrency,
      status,
      called_amount: calledAmount,
      fmv_amount: fmvAmount,
      realized_amount: realizedAmount,
      dpi,
      tvpi,
      irr,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create fund';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
