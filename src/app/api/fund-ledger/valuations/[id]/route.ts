import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import {
  createContainer,
  FL_DOMAIN_ERRORS,
  type UpdateValuationInput,
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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flValuationService } = createContainer(db, workspaceId);

    const data = await flValuationService.getValuationById(workspaceId, id);
    if (!data) {
      return NextResponse.json(
        { error: 'Valuation not found' },
        { status: 404 },
      );
    }
    return NextResponse.json({ data });
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
    const db = createDb();
    const { flValuationService } = createContainer(db, workspaceId);
    const body = await req.json();

    // Explicit field-by-field assignment.
    // Financial fields pass through directly without coercion so invalid numeric JSON
    // is preserved and rejected by domain validation.
    const updates: UpdateValuationInput = {};
    if (body.asset_id !== undefined) updates.asset_id = body.asset_id;
    if (body.fund_id !== undefined) updates.fund_id = body.fund_id;
    if (body.position_id !== undefined) updates.position_id = body.position_id;
    if (body.as_of_date !== undefined) updates.as_of_date = body.as_of_date;
    if (body.valuation_method !== undefined)
      updates.valuation_method = body.valuation_method;
    if (body.currency !== undefined) updates.currency = body.currency;
    if (body.market_value !== undefined)
      updates.market_value = body.market_value;
    if (body.price_per_unit !== undefined)
      updates.price_per_unit = body.price_per_unit;
    if (body.units_outstanding !== undefined)
      updates.units_outstanding = body.units_outstanding;
    if (body.gross_value !== undefined) updates.gross_value = body.gross_value;
    if (body.net_value !== undefined) updates.net_value = body.net_value;
    if (body.data_status !== undefined) updates.data_status = body.data_status;
    if (body.source_record_id !== undefined)
      updates.source_record_id = body.source_record_id;
    if (body.notes !== undefined) updates.notes = body.notes;

    const data = await flValuationService.update(
      workspaceId,
      id,
      updates,
    );
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flValuationService } = createContainer(db, workspaceId);

    await flValuationService.delete(workspaceId, id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
