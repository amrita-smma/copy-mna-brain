import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { FundAssetNotFoundError } from '@/lib/services/fundService';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    const { assetId } = await params;
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundService.getAsset(assetId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof FundAssetNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to fetch fund asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    const { assetId } = await params;
    const {
      assetName,
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
      fmvAmount,
      grossMoic,
      grossIrr,
      dpi,
      investedCapitalAmount,
      netDistributionAmount,
      shareCount,
    } = await req.json();
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundService.updateAsset(assetId, {
      ...(assetName !== undefined ? { asset_name: assetName } : {}),
      ...(legalName !== undefined ? { legal_name: legalName } : {}),
      ...(country !== undefined ? { country } : {}),
      ...(fundingSource !== undefined ? { funding_source: fundingSource } : {}),
      ...(investmentType !== undefined ? { investment_type: investmentType } : {}),
      ...(entryDate !== undefined ? { entry_date: entryDate } : {}),
      ...(maturityDate !== undefined ? { maturity_date: maturityDate } : {}),
      ...(commitmentAmount !== undefined ? { commitment_amount: commitmentAmount } : {}),
      ...(stakePct !== undefined ? { stake_pct: stakePct } : {}),
      ...(sector !== undefined ? { sector } : {}),
      ...(subSector !== undefined ? { sub_sector: subSector } : {}),
      ...(investmentCurrency !== undefined ? { investment_currency: investmentCurrency } : {}),
      ...(reportCurrency !== undefined ? { report_currency: reportCurrency } : {}),
      ...(investmentDescription !== undefined
        ? { investment_description: investmentDescription }
        : {}),
      ...(keyRights !== undefined ? { key_rights: keyRights } : {}),
      ...(subscriptionFeeAmount !== undefined
        ? { subscription_fee_amount: subscriptionFeeAmount }
        : {}),
      ...(mgmtFeeRatePct !== undefined ? { mgmt_fee_rate_pct: mgmtFeeRatePct } : {}),
      ...(carryRatePct !== undefined ? { carry_rate_pct: carryRatePct } : {}),
      ...(legalFeesAmount !== undefined ? { legal_fees_amount: legalFeesAmount } : {}),
      ...(typeDetails !== undefined ? { type_details: typeDetails } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(currentPricePerShare !== undefined
        ? { current_price_per_share: currentPricePerShare }
        : {}),
      ...(fmvAmount !== undefined ? { fmv_amount: fmvAmount } : {}),
      ...(grossMoic !== undefined ? { gross_moic: grossMoic } : {}),
      ...(grossIrr !== undefined ? { gross_irr: grossIrr } : {}),
      ...(dpi !== undefined ? { dpi } : {}),
      ...(investedCapitalAmount !== undefined ? { invested_capital_amount: investedCapitalAmount } : {}),
      ...(netDistributionAmount !== undefined ? { net_distribution_amount: netDistributionAmount } : {}),
      ...(shareCount !== undefined ? { share_count: shareCount } : {}),
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof FundAssetNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to update fund asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    const { assetId } = await params;
    const db = createDb();
    const { fundService } = createContainer(db, await getActiveWorkspaceId());
    await fundService.deleteAsset(assetId);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof FundAssetNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to delete fund asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
