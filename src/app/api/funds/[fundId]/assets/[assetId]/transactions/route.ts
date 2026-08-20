import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { InvalidTransactionError } from '@/lib/services/fundAssetLedgerService';
import { isSellProceedsDestination } from '@/lib/sellProceedsDestination';
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
    const reqBody = await req.json();
    const {
      txnDate,
      txnType,
      subTypeLabel,
      pricePerShare,
      shareCount,
      valueAmount,
      txnCurrency,
      fxRate,
      sellProceedsDestination,
      notes,
      fundId: bodyFundId,
      holdingEntityId,
      fundingSourceId,
      sourceDivestmentTxnId,
      source_divestment_txn_id,
    } = reqBody;
    if (!txnDate || !txnType) {
      return NextResponse.json({ error: 'txnDate and txnType are required' }, { status: 400 });
    }
    if (txnType === 'internal_transfer') {
      return NextResponse.json(
        { error: 'internal_transfer transactions cannot be created directly' },
        { status: 400 },
      );
    }
    if (sourceDivestmentTxnId !== undefined || source_divestment_txn_id !== undefined) {
      return NextResponse.json(
        { error: 'sourceDivestmentTxnId cannot be set manually' },
        { status: 400 },
      );
    }
    if (txnType === 'divestment') {
      if (!sellProceedsDestination) {
        return NextResponse.json(
          { error: 'sellProceedsDestination is required for divestment' },
          { status: 400 },
        );
      }
      if (!isSellProceedsDestination(sellProceedsDestination)) {
        return NextResponse.json(
          { error: 'Invalid sellProceedsDestination: must be cash_in_fund or distributed_to_investor' },
          { status: 400 },
        );
      }
      const resolvedFundId =
        bodyFundId !== undefined
          ? bodyFundId === 'unassigned'
            ? null
            : bodyFundId
          : fundId === 'unassigned'
            ? null
            : fundId;
      if (sellProceedsDestination === 'cash_in_fund' && !resolvedFundId) {
        return NextResponse.json(
          { error: 'fundId is required when sellProceedsDestination is cash_in_fund' },
          { status: 400 },
        );
      }
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
      sell_proceeds_destination: txnType === 'divestment' ? sellProceedsDestination : null,
      notes,
      fund_id: bodyFundId !== undefined ? (bodyFundId === 'unassigned' ? null : bodyFundId) : (fundId === 'unassigned' ? null : fundId),
      holding_entity_id: actualHoldingEntityId,
      funding_source_id: actualFundingSourceId,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof InvalidTransactionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to add transaction';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
