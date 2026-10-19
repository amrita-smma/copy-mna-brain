import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  FL_DOMAIN_ERRORS,
  type UpdateFundingSourceInput,
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

    const data = await flMasterDataService.getFundingSourceById(
      workspaceId,
      id,
    );
    if (!data) {
      return NextResponse.json(
        { error: 'Funding source not found' },
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

    const updates: UpdateFundingSourceInput = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.source_type !== undefined) updates.source_type = body.source_type;
    if (body.owner_investor_id !== undefined)
      updates.owner_investor_id = body.owner_investor_id;
    if (body.currency !== undefined) updates.currency = body.currency;

    const data = await flMasterDataService.updateFundingSource(
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

    await flMasterDataService.deleteFundingSource(workspaceId, id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
