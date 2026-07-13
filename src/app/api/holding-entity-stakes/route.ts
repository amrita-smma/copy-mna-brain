import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { FundHoldingEntityStakeScopeError } from '@/lib/services/fundHoldingEntityStakeService';

export async function GET() {
  try {
    const db = createDb();
    const { fundHoldingEntityStakeService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundHoldingEntityStakeService.listStakes();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch holding entity stakes';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const {
      fundId,
      investorId,
      holdingEntityId,
      commitmentAmount,
      commitmentAmountCurrency,
      investedAmount,
      investedAmountCurrency,
    } = await req.json();
    const resolvedEntityId = holdingEntityId || investorId;
    if (!fundId || !resolvedEntityId) {
      return NextResponse.json({ error: 'fundId and holdingEntityId are required' }, { status: 400 });
    }
    const db = createDb();
    const { fundHoldingEntityStakeService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundHoldingEntityStakeService.upsertStake({
      fundId,
      holdingEntityId: resolvedEntityId,
      commitmentAmount,
      commitmentAmountCurrency,
      investedAmount,
      investedAmountCurrency,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof FundHoldingEntityStakeScopeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to save holding entity stake';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
