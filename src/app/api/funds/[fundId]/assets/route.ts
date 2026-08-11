import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ fundId: string }> }) {
  try {
    const { fundId } = await params;
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundService.listAssets(fundId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch fund assets';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ fundId: string }> }) {
  try {
    const { fundId } = await params;
    const {
      assetType,
      assetName,
      englishName,
      legalName,
      country,
      fundingSource,
      investmentType,
      entryDate,
      maturityDate,
      commitmentAmount,
      stakePct,
      sector,
      subSector,
      investmentCurrency,
      reportCurrency,
      investmentDescription,
      keyRights,
      subscriptionFeeAmount,
      mgmtFeeRatePct,
      carryRatePct,
      legalFeesAmount,
      typeDetails,
      status,
      currentPricePerShare,
    } = await req.json();
    if (!assetType) {
      return NextResponse.json({ error: 'assetType is required' }, { status: 400 });
    }
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundService.addAsset({
      asset_type: assetType,
      asset_name: assetName,
      english_name: englishName,
      legal_name: legalName,
      country,
      funding_source: fundingSource,
      investment_type: investmentType,
      entry_date: entryDate,
      maturity_date: maturityDate,
      commitment_amount: commitmentAmount,
      stake_pct: stakePct,
      sector,
      sub_sector: subSector,
      investment_currency: investmentCurrency,
      report_currency: reportCurrency,
      investment_description: investmentDescription,
      key_rights: keyRights,
      subscription_fee_amount: subscriptionFeeAmount,
      mgmt_fee_rate_pct: mgmtFeeRatePct,
      carry_rate_pct: carryRatePct,
      legal_fees_amount: legalFeesAmount,
      type_details: typeDetails,
      status,
      current_price_per_share: currentPricePerShare,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to add fund asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
