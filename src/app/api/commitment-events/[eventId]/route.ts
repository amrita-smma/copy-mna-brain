import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import {
  FundCommitmentEventNotFoundError,
  FundCommitmentEventScopeError,
  CommitmentNegativeBalanceError,
  InvalidCommitmentEventError,
  isCommitmentEventType,
} from '@/lib/services/fundCommitmentEventService';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await params;
    const db = createDb();
    const { fundCommitmentEventService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundCommitmentEventService.getEvent(eventId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof FundCommitmentEventNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to fetch commitment event';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await params;
    const body = await req.json();
    const {
      effectiveDate,
      eventType,
      amount,
      currency,
      notes,
      counterpartyHoldingEntityId,
    } = body;

    if (eventType !== undefined && !isCommitmentEventType(eventType)) {
      return NextResponse.json(
        {
          error: `Invalid event type: ${eventType}. Must be one of initial_commitment, additional_commitment, reduction, transfer_in, transfer_out`,
        },
        { status: 400 },
      );
    }

    const numAmount = amount !== undefined ? Number(amount) : undefined;
    if (numAmount !== undefined && (isNaN(numAmount) || numAmount <= 0)) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { fundCommitmentEventService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fundCommitmentEventService.updateEvent(eventId, {
      effectiveDate,
      eventType,
      amount: numAmount,
      currency,
      notes,
      counterpartyHoldingEntityId,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof FundCommitmentEventNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof FundCommitmentEventScopeError ||
      error instanceof CommitmentNegativeBalanceError ||
      error instanceof InvalidCommitmentEventError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to update commitment event';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const { eventId } = await params;
    const db = createDb();
    const { fundCommitmentEventService } = createContainer(db, await getActiveWorkspaceId());
    await fundCommitmentEventService.deleteEvent(eventId);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof FundCommitmentEventNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof CommitmentNegativeBalanceError ||
      error instanceof InvalidCommitmentEventError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Failed to delete commitment event';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
