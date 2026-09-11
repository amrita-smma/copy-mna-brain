import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import {
  createContainer,
  FL_DOMAIN_ERRORS,
  type UpdateFundInput,
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
    const { flMasterDataService } = createContainer(db, workspaceId);

    const data = await flMasterDataService.getFundById(workspaceId, id);
    if (!data) {
      return NextResponse.json({ error: 'Fund not found' }, { status: 404 });
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
    const { flMasterDataService } = createContainer(db, workspaceId);
    const body = await req.json();

    // Internal ID and workspace_id omissions enforced field-by-field.
    // Financial/rate fields pass through directly without coercion.
    const updates: UpdateFundInput = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.legal_name !== undefined) updates.legal_name = body.legal_name;
    if (body.english_name !== undefined) updates.english_name = body.english_name;
    if (body.registration_no !== undefined)
      updates.registration_no = body.registration_no;
    if (body.managed !== undefined) updates.managed = body.managed;
    if (body.ownership_basis !== undefined)
      updates.ownership_basis = body.ownership_basis;
    if (body.base_currency !== undefined)
      updates.base_currency = body.base_currency;
    if (body.vintage_year !== undefined)
      updates.vintage_year = body.vintage_year;
    if (body.fund_life_years !== undefined)
      updates.fund_life_years = body.fund_life_years;
    if (body.status !== undefined) updates.status = body.status;
    if (body.mgmt_fee_rate !== undefined)
      updates.mgmt_fee_rate = body.mgmt_fee_rate;
    if (body.carry_rate !== undefined) updates.carry_rate = body.carry_rate;
    if (body.preferred_return_rate !== undefined)
      updates.preferred_return_rate = body.preferred_return_rate;
    if (body.description !== undefined) updates.description = body.description;

    const data = await flMasterDataService.updateFund(
      workspaceId,
      id,
      updates,
    );
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
