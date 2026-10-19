import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import {
  FL_DOMAIN_ERRORS,
  type UpdateAssetInput,
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

    const data = await flMasterDataService.getAssetById(workspaceId, id);
    if (!data) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
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

    const updates: UpdateAssetInput = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.legal_name !== undefined) updates.legal_name = body.legal_name;
    if (body.english_name !== undefined) updates.english_name = body.english_name;
    if (body.asset_kind !== undefined) updates.asset_kind = body.asset_kind;
    if (body.country !== undefined) updates.country = body.country;
    if (body.sector !== undefined) updates.sector = body.sector;
    if (body.sub_sector !== undefined) updates.sub_sector = body.sub_sector;
    if (body.instrument_terms !== undefined)
      updates.instrument_terms = body.instrument_terms;
    if (body.description !== undefined) updates.description = body.description;
    if (body.action_items !== undefined) {
      if (body.action_items !== null && typeof body.action_items !== 'string') {
        return NextResponse.json(
          { error: 'action_items must be a string or null' },
          { status: 400 },
        );
      }
      updates.action_items = body.action_items;
    }

    const data = await flMasterDataService.updateAsset(
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
    const { flLedgerService } = createContainer(db, workspaceId);

    const data = await flLedgerService.deleteAssetWithLedger(workspaceId, id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
