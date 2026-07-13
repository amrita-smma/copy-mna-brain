import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

// One batched call that returns every fund with its assets and each asset's
// full transaction + valuation ledger. Replaces the view's per-asset fan-out
// (which opened a DB connection per asset and exhausted the pool).
export async function GET() {
  try {
    const db = createDb();
    const { fundPortfolioService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundPortfolioService.getPortfolio();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch portfolio';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
