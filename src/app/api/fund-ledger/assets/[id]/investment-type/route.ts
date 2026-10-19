import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer, FL_DOMAIN_ERRORS } from '@/lib/services';

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
  console.error(error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Assigns the asset to an investment type; `investment_type_id: null` unassigns it. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const typeId = body?.investment_type_id;
    if (typeId !== null && typeof typeId !== 'string') {
      return NextResponse.json(
        { error: 'investment_type_id must be a string or null' },
        { status: 400 },
      );
    }
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { flInvestmentTypeService } = createContainer(db, workspaceId);
    const data = await flInvestmentTypeService.assignAsset(workspaceId, id, typeId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
