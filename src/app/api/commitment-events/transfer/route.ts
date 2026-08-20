import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import {
  FundCommitmentEventScopeError,
  CommitmentNegativeBalanceError,
  InvalidCommitmentEventError,
} from '@/lib/services/fundCommitmentEventService';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      fundId,
      fromHoldingEntityId,
      fromInvestorId,
      toHoldingEntityId,
      toInvestorId,
      effectiveDate,
      amount,
      currency,
      notes,
    } = body;

    const resolvedFromId = fromHoldingEntityId || fromInvestorId;
    const resolvedToId = toHoldingEntityId || toInvestorId;

    if (!fundId || !resolvedFromId || !resolvedToId || !effectiveDate || amount === undefined) {
      return NextResponse.json(
        {
          error:
            'fundId, fromHoldingEntityId, toHoldingEntityId, effectiveDate, and amount are required',
        },
        { status: 400 },
      );
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 },
      );
    }

    if (resolvedFromId === resolvedToId) {
      return NextResponse.json(
        { error: 'fromHoldingEntityId and toHoldingEntityId must be different' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { fundCommitmentEventService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundCommitmentEventService.createTransfer({
      fundId,
      fromHoldingEntityId: resolvedFromId,
      toHoldingEntityId: resolvedToId,
      effectiveDate,
      amount: numAmount,
      currency: currency || 'USD',
      notes: notes || null,
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    if (
      error instanceof FundCommitmentEventScopeError ||
      error instanceof CommitmentNegativeBalanceError ||
      error instanceof InvalidCommitmentEventError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to create commitment transfer';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
