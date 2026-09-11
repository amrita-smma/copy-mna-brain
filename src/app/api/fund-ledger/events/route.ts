import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
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
    )
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

export async function POST(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flLedgerService } = createContainer(db, workspaceId);
    const body = await req.json();

    // Internal-only deterministic IDs (id, business_event_id, entry IDs, allocation IDs)
    // are intentionally omitted: API routes must never forward caller-supplied internal IDs
    // and must build service inputs field-by-field rather than spreading request JSON.
    // Financial fields pass through directly without coercion so invalid numeric JSON
    // is preserved and rejected by domain validation in Phase 3.
    const data = await flLedgerService.postEvent(workspaceId, {
      event_date: body.event_date,
      description: body.description ?? null,
      source_record_id: body.source_record_id ?? null,
      entries: (body.entries ?? []).map((e: any) => ({
        position_id: e.position_id,
        entry_date: e.entry_date,
        entry_type: e.entry_type,
        sub_type: e.sub_type ?? null,
        commitment_delta: e.commitment_delta,
        quantity_delta: e.quantity_delta,
        // An adjustment carries its whole amount here, so omitting it silently
        // posted a zero row: the field list is exhaustive by design, and this
        // was missing from it.
        valuation_delta: e.valuation_delta,
        cash_delta: e.cash_delta,
        currency: e.currency,
        fx_rate: e.fx_rate ?? null,
        price_per_unit: e.price_per_unit ?? null,
        counterparty_position_id: e.counterparty_position_id ?? null,
        data_status: e.data_status,
        source_record_id: e.source_record_id ?? null,
        primary_entry_index: e.primary_entry_index,
        source_entry_index: e.source_entry_index,
        notes: e.notes ?? null,
        allocations: e.allocations?.map((a: any) => ({
          funding_source_id: a.funding_source_id,
          amount: a.amount,
        })),
      })),
      allocations: body.allocations?.map((a: any) => ({
        entry_index: a.entry_index,
        funding_source_id: a.funding_source_id,
        amount: a.amount,
      })),
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
