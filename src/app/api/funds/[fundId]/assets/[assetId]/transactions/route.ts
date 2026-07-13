import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { isUuid } from '@/lib/uuid';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ fundId: string, assetId: string }> },
) {
  try {
    const { fundId, assetId } = await params;
    const db = createDb();
    const { fundAssetLedgerService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundAssetLedgerService.listTransactions(assetId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch transactions';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ fundId: string, assetId: string }> },
) {
  try {
    const { fundId, assetId } = await params;
    const {
      txnDate,
      txnType,
      subTypeLabel,
      pricePerShare,
      shareCount,
      valueAmount,
      txnCurrency,
      fxRate,
      notes,
      fundId: bodyFundId,
      holdingEntityId,
      fundingSourceId,
    } = await req.json();
    if (!txnDate || !txnType) {
      return NextResponse.json({ error: 'txnDate and txnType are required' }, { status: 400 });
    }
    const db = createDb();
    const { fundAssetLedgerService, holdingEntityService, fundSourceService } = createContainer(db, await getActiveWorkspaceId());

    let actualHoldingEntityId = holdingEntityId;
    if (holdingEntityId && !isUuid(holdingEntityId)) {
      const existing = await holdingEntityService.listHoldingEntities();
      let he = existing.find((e) => e.name === holdingEntityId);
      if (!he) he = await holdingEntityService.createHoldingEntity({ name: holdingEntityId });
      actualHoldingEntityId = he.id;
    }

    let actualFundingSourceId = fundingSourceId;
    if (fundingSourceId && !isUuid(fundingSourceId)) {
      const existing = await fundSourceService.listFundSources();
      let fs = existing.find((e) => e.name === fundingSourceId);
      if (!fs) fs = await fundSourceService.createFundSource({ name: fundingSourceId });
      actualFundingSourceId = fs.id;
    }

    const data = await fundAssetLedgerService.addTransaction(assetId, {
      txn_date: txnDate,
      txn_type: txnType,
      sub_type_label: subTypeLabel,
      price_per_share: pricePerShare,
      share_count: shareCount,
      value_amount: valueAmount,
      txn_currency: txnCurrency,
      fx_rate: fxRate,
      notes,
      fund_id: bodyFundId !== undefined ? (bodyFundId === 'unassigned' ? null : bodyFundId) : (fundId === 'unassigned' ? null : fundId),
      holding_entity_id: actualHoldingEntityId,
      funding_source_id: actualFundingSourceId,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to add transaction';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
