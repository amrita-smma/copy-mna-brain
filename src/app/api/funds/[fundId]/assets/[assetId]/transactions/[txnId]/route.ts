import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import {
  LastTransactionDeleteError,
  TransactionNotFoundError,
} from '@/lib/services/fundAssetLedgerService';
import { isUuid } from '@/lib/uuid';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ fundId: string; assetId: string; txnId: string }> },
) {
  try {
    const { assetId, txnId } = await params;
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
    const db = createDb();
    const { fundAssetLedgerService, holdingEntityService, fundSourceService } = createContainer(db, await getActiveWorkspaceId());

    let actualHoldingEntityId = holdingEntityId;
    if (holdingEntityId !== undefined) {
      if (holdingEntityId && !isUuid(holdingEntityId)) {
        const existing = await holdingEntityService.listHoldingEntities();
        let he = existing.find((e) => e.name === holdingEntityId);
        if (!he) he = await holdingEntityService.createHoldingEntity({ name: holdingEntityId });
        actualHoldingEntityId = he.id;
      }
    }

    let actualFundingSourceId = fundingSourceId;
    if (fundingSourceId !== undefined) {
      if (fundingSourceId && !isUuid(fundingSourceId)) {
        const existing = await fundSourceService.listFundSources();
        let fs = existing.find((e) => e.name === fundingSourceId);
        if (!fs) fs = await fundSourceService.createFundSource({ name: fundingSourceId });
        actualFundingSourceId = fs.id;
      }
    }

    const data = await fundAssetLedgerService.updateTransaction(assetId, txnId, {
      ...(txnDate !== undefined && { txn_date: txnDate }),
      ...(txnType !== undefined && { txn_type: txnType }),
      ...(subTypeLabel !== undefined && { sub_type_label: subTypeLabel }),
      ...(pricePerShare !== undefined && { price_per_share: pricePerShare }),
      ...(shareCount !== undefined && { share_count: shareCount }),
      ...(valueAmount !== undefined && { value_amount: valueAmount }),
      ...(txnCurrency !== undefined && { txn_currency: txnCurrency }),
      ...(fxRate !== undefined && { fx_rate: fxRate }),
      ...(notes !== undefined && { notes }),
      ...(bodyFundId !== undefined && { fund_id: bodyFundId === 'unassigned' ? null : bodyFundId }),
      ...(holdingEntityId !== undefined && { holding_entity_id: actualHoldingEntityId }),
      ...(fundingSourceId !== undefined && { funding_source_id: actualFundingSourceId }),
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof TransactionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to update transaction';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ fundId: string; assetId: string; txnId: string }> },
) {
  try {
    const { assetId, txnId } = await params;
    const db = createDb();
    const { fundAssetLedgerService } = createContainer(db, await getActiveWorkspaceId());
    await fundAssetLedgerService.deleteTransaction(assetId, txnId);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof LastTransactionDeleteError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Failed to delete transaction';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
