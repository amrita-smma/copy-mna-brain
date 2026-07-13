import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    const { assetId } = await params;
    const db = createDb();
    const { fundAssetLedgerService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundAssetLedgerService.listValuations(assetId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch valuations';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    const { assetId } = await params;
    const {
      asOfDate,
      periodLabel,
      valuationMethod,
      currency,
      marketValueAmount,
      pricePerShare,
      sharesOutstanding,
      shareholdingPct,
      investedCapitalCumAmount,
      netDistributionAmount,
      grossMoic,
      dpi,
      grossXirr,
      notes,
    } = await req.json();
    if (!asOfDate) {
      return NextResponse.json({ error: 'asOfDate is required' }, { status: 400 });
    }
    const db = createDb();
    const { fundAssetLedgerService } = createContainer(db, await getActiveWorkspaceId());
    // Upsert, keyed on (fund_asset_id, as_of_date): reprocessing the same
    // date updates the existing snapshot instead of creating a duplicate.
    const data = await fundAssetLedgerService.upsertValuation(assetId, {
      as_of_date: asOfDate,
      period_label: periodLabel,
      valuation_method: valuationMethod,
      currency,
      market_value_amount: marketValueAmount,
      price_per_share: pricePerShare,
      shares_outstanding: sharesOutstanding,
      shareholding_pct: shareholdingPct,
      invested_capital_cum_amount: investedCapitalCumAmount,
      net_distribution_amount: netDistributionAmount,
      gross_moic: grossMoic,
      dpi,
      gross_xirr: grossXirr,
      notes,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to save valuation';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
