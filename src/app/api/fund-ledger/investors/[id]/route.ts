import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  FL_DOMAIN_ERRORS,
  type UpdateInvestorInput,
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

    const data = await flMasterDataService.getInvestorById(workspaceId, id);
    if (!data) {
      return NextResponse.json(
        { error: 'Investor not found' },
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
    const { flMasterDataService } = createContainer(db, workspaceId);
    const body = await req.json();

    const updates: UpdateInvestorInput = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.legal_name !== undefined) updates.legal_name = body.legal_name;
    if (body.english_name !== undefined) updates.english_name = body.english_name;
    if (body.investor_type !== undefined)
      updates.investor_type = body.investor_type;
    if (body.country !== undefined) updates.country = body.country;
    if (body.parent_investor_id !== undefined)
      updates.parent_investor_id = body.parent_investor_id;
    if (body.notes !== undefined) updates.notes = body.notes;

    const data = await flMasterDataService.updateInvestor(
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
    const { flMasterDataService } = createContainer(db, workspaceId);

    await flMasterDataService.deleteInvestor(workspaceId, id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
