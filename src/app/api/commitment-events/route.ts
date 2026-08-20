import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import {
  FundCommitmentEventScopeError,
  CommitmentNegativeBalanceError,
  InvalidCommitmentEventError,
  isCommitmentEventType,
} from '@/lib/services/fundCommitmentEventService';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const fundId = searchParams.get('fundId') || undefined;
    const holdingEntityId = searchParams.get('holdingEntityId') || undefined;

    const db = createDb();
    const { fundCommitmentEventService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundCommitmentEventService.listEvents({ fundId, holdingEntityId });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch commitment events';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      fundId,
      holdingEntityId,
      investorId,
      effectiveDate,
      eventType,
      amount,
      currency,
      counterpartyHoldingEntityId,
      transferGroupId,
      notes,
      source,
    } = body;

    const resolvedEntityId = holdingEntityId || investorId;
    if (!fundId || !resolvedEntityId || !effectiveDate || !eventType || amount === undefined) {
      return NextResponse.json(
        { error: 'fundId, holdingEntityId, effectiveDate, eventType, and amount are required' },
        { status: 400 },
      );
    }

    if (!isCommitmentEventType(eventType)) {
      return NextResponse.json(
        {
          error: `Invalid event type: ${eventType}. Must be one of initial_commitment, additional_commitment, reduction, transfer_in, transfer_out`,
        },
        { status: 400 },
      );
    }

    if (eventType === 'transfer_in' || eventType === 'transfer_out') {
      return NextResponse.json(
        {
          error:
            'Transfers cannot be created via POST /api/commitment-events. Use POST /api/commitment-events/transfer instead to ensure matched pairs.',
        },
        { status: 400 },
      );
    }

    if (transferGroupId) {
      return NextResponse.json(
        { error: 'Caller-supplied transferGroupId is not allowed on POST /api/commitment-events.' },
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

    const db = createDb();
    const { fundCommitmentEventService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundCommitmentEventService.createEvent({
      fundId,
      holdingEntityId: resolvedEntityId,
      effectiveDate,
      eventType,
      amount: numAmount,
      currency: currency || 'USD',
      counterpartyHoldingEntityId: counterpartyHoldingEntityId || null,
      notes: notes || null,
      source: source || 'manual',
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
    const message = error instanceof Error ? error.message : 'Failed to create commitment event';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
