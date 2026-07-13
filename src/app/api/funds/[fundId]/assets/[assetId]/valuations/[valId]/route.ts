import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { ValuationNotFoundError } from '@/lib/services/fundAssetLedgerService';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string; valId: string }> },
) {
  try {
    const { assetId, valId } = await params;
    const db = createDb();
    const { fundAssetLedgerService } = createContainer(db, await getActiveWorkspaceId());
    await fundAssetLedgerService.deleteValuation(assetId, valId);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof ValuationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to delete valuation';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
