import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { UserRepository } from '@/lib/repositories/userRepository';
import {
  createContainer,
  FL_DOMAIN_ERRORS,
  type PostEventInput,
  type FlLedgerEntryInput,
  type FlAllocationInput,
} from '@/lib/services';

function handleRouteError(error: unknown) {
  if (
    FL_DOMAIN_ERRORS.some(
      (cls) =>
        error instanceof cls ||
        (error instanceof Error && error.name === cls.name),
    ) ||
    (error instanceof Error && error.name === 'AllocationSourceMismatchError')
  ) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message, error_name: err.name },
      { status: 422 },
    );
  }
  const message =
    error instanceof Error ? error.message : 'Internal server error';
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flLedgerService } = createContainer(db, workspaceId);

    const event = await flLedgerService.getEventById(workspaceId, id);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const entries = await flLedgerService.getEntriesByEventId(workspaceId, id);
    const allocations = await flLedgerService.getAllocationsByEntryIds(
      workspaceId,
      entries.map((entry) => entry.id),
    );
    return NextResponse.json({ data: { event, entries, allocations } });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const session = await auth();
    const db = createDb();
    const userRepo = new UserRepository(db);
    const currentUser = session?.user?.email
      ? await userRepo.findByEmail(session.user.email)
      : null;
    const { flLedgerService } = createContainer(db, workspaceId);
    const body = await req.json();

    // Internal IDs (id, business_event_id, workspace_id, is_reversal, created_by)
    // are strictly omitted at all levels (replacement event, entries, allocations).
    // Financial fields pass through directly without coercion so invalid numeric JSON
    // is preserved and rejected by domain validation.
    // source_record_id is authorized business input and workspace-validated by the service.
    const mappedEntries: FlLedgerEntryInput[] = Array.isArray(body.entries)
      ? body.entries.map((entry: any): FlLedgerEntryInput => {
          const mappedAllocations: FlAllocationInput[] | undefined = Array.isArray(entry.allocations)
            ? entry.allocations.map((alloc: any): FlAllocationInput => ({
                funding_source_id: alloc.funding_source_id,
                amount: alloc.amount,
              }))
            : undefined;

          return {
            position_id: entry.position_id,
            entry_type: entry.entry_type,
            sub_type: entry.sub_type ?? null,
            commitment_delta: entry.commitment_delta,
            quantity_delta: entry.quantity_delta,
            // Without this an edit to an adjustment's Δ was accepted and
            // discarded, saving the entry back with a zero valuation.
            valuation_delta: entry.valuation_delta,
            cash_delta: entry.cash_delta,
            currency: entry.currency,
            fx_rate: entry.fx_rate ?? null,
            price_per_unit: entry.price_per_unit ?? null,
            counterparty_position_id: entry.counterparty_position_id ?? null,
            data_status: entry.data_status ?? 'verified',
            source_record_id: entry.source_record_id ?? null,
            primary_entry_index: entry.primary_entry_index,
            source_entry_index: entry.source_entry_index,
            notes: entry.notes ?? null,
            allocations: mappedAllocations,
          };
        })
      : [];

    const replacementInput: PostEventInput = {
      event_date: body.event_date,
      description: body.description ?? null,
      source_record_id: body.source_record_id ?? null,
      entries: mappedEntries,
    };

    const options = {
      updated_by: currentUser?.id ?? null,
    };

    const data = await flLedgerService.updateEvent(
      workspaceId,
      id,
      replacementInput,
      options,
    );

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flLedgerService } = createContainer(db, workspaceId);

    let options: { description?: string; event_date?: string } | undefined =
      undefined;
    try {
      const body = await req.json();
      if (body) {
        options = {
          description: body.description ?? undefined,
          event_date: body.event_date ?? undefined,
        };
      }
    } catch {
      // Body is optional for DELETE
    }

    const data = await flLedgerService.reverseEvent(workspaceId, id, options);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
