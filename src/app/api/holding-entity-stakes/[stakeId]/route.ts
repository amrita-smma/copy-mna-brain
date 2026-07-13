import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { FundHoldingEntityStakeNotFoundError } from '@/lib/services/fundHoldingEntityStakeService';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ stakeId: string }> },
) {
  try {
    const { stakeId } = await params;
    const db = createDb();
    const { fundHoldingEntityStakeService } = createContainer(db, await getActiveWorkspaceId());
    await fundHoldingEntityStakeService.deleteStake(stakeId);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof FundHoldingEntityStakeNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to delete holding entity stake';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
